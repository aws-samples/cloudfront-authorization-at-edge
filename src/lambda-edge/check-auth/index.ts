// Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { stringify as stringifyQueryString } from 'querystring';
import { createHash, randomBytes, createHmac } from 'crypto';
import { CloudFrontRequestHandler } from 'aws-lambda';
import { validate } from './validate-jwt';
import { getConfig, extractAndParseCookies, decodeToken, urlSafe } from '../shared/shared';
import { parse } from 'cookie';

const { logger, ...CONFIG } = getConfig();
// Allowed characters per https://tools.ietf.org/html/rfc7636#section-4.1
const SECRET_ALLOWED_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
const PKCE_LENGTH = 43; // Should be between 43 and 128 - per spec
const NONCE_LENGTH = 16; // how many characters should your nonces be?
const NONCE_MAX_AGE = parseInt(parse(CONFIG.cookieSettings.nonce.toLowerCase())['max-age']) || 60 * 60 * 24;

export const handler: CloudFrontRequestHandler = async (event) => {
    logger.debug(event);
    const request = event.Records[0].cf.request;
    const domainName = request.headers['host'][0].value;
    const requestedUri = `${request.uri}${request.querystring ? '?' + request.querystring : ''}`;
    let existingState: State | undefined = undefined;
    try {
        const { idToken, refreshToken, nonce, nonceHmac } = extractAndParseCookies(request.headers, CONFIG.clientId);
        logger.debug('Extracted cookies:\n', { idToken, refreshToken, nonce, nonceHmac });

        // Reuse existing nonce and pkce to be more lenient to users doing parallel sign-in's
        if (nonce && nonceHmac) {
            existingState = { nonce, nonceHmac };
            logger.debug('Existing state found:\n', existingState);
        }

        // If there's no ID token in your cookies then you are not signed in yet
        if (!idToken) {
            throw new Error('No ID token present in cookies');
        }

        // If the ID token has expired or expires in less than 10 minutes and there is a refreshToken: refresh tokens
        // This is done by redirecting the user to the refresh endpoint
        // After the tokens are refreshed the user is redirected back here (probably without even noticing this double redirect)
        const { exp } = decodeToken(idToken);
        logger.debug('ID token exp:', exp, new Date(exp * 1000).toISOString());
        if ((Date.now() / 1000) > exp - (60 * 10) && refreshToken) {
            logger.info('Will redirect to refresh endpoint for refreshing tokens using refresh token');
            const nonce = generateNonce();
            const response = {
                status: '307',
                statusDescription: 'Temporary Redirect',
                headers: {
                    'location': [{
                        key: 'location',
                        value: `https://${domainName}${CONFIG.redirectPathAuthRefresh}?${stringifyQueryString({ requestedUri, nonce })}`
                    }],
                    'set-cookie': [
                        { key: 'set-cookie', value: `spa-auth-edge-nonce=${encodeURIComponent(nonce)}; ${CONFIG.cookieSettings.nonce}` },
                        { key: 'set-cookie', value: `spa-auth-edge-nonce-hmac=${encodeURIComponent(signNonce(nonce, CONFIG.nonceSigningSecret))}; ${CONFIG.cookieSettings.nonce}` },
                    ],
                    ...CONFIG.cloudFrontHeaders,
                }
            };
            logger.debug('Returning response:\n', response);
            return response;
        }

        // Check that the ID token is valid. This throws an error if it's not
        logger.info('Validating JWT ...');
        await validate(idToken, CONFIG.tokenJwksUri, CONFIG.tokenIssuer, CONFIG.clientId);
        logger.info('JWT is valid');

        // Return the request unaltered to allow access to the resource:
        logger.debug('Returning request:\n', request);
        return request;

    } catch (err) {
        logger.info(`Will redirect to Cognito for sign-in because: ${err}`);

        // Reuse existing state if possible, to be more lenient to users doing parallel sign-in's
        // Users being users, may open the sign-in page in one browser tab, do something else,
        // open the sign-in page in another tab, do something else, come back to the first tab and complete the sign-in (etc.)
        let state: State;
        const { pkce, pkceHash } = generatePkceVerifier();
        if (existingState && stateIsValid(existingState, CONFIG.nonceSigningSecret)) {
            state = existingState;
            logger.debug('Reusing existing state\n', state);
        } else {
            const nonce = generateNonce();
            state = {
                nonce,
                nonceHmac: signNonce(nonce, CONFIG.nonceSigningSecret),
            }
            logger.debug('Using new state\n', state);
        }

        // Encode the state variable as base64 to avoid a bug in Cognito hosted UI when using multiple identity providers
        // Cognito decodes the URL, causing a malformed link due to the JSON string, and results in an empty 400 response from Cognito.
        const loginQueryString = stringifyQueryString({
            redirect_uri: `https://${domainName}${CONFIG.redirectPathSignIn}`,
            response_type: 'code',
            client_id: CONFIG.clientId,
            state: urlSafe.stringify(Buffer.from(JSON.stringify({ nonce: state.nonce, requestedUri })).toString('base64')),
            scope: CONFIG.oauthScopes.join(' '),
            code_challenge_method: 'S256',
            code_challenge: pkceHash,
        });

        // Return redirect to Cognito Hosted UI for sign-in
        const response = {
            status: '307',
            statusDescription: 'Temporary Redirect',
            headers: {
                'location': [{
                    key: 'location',
                    value: `https://${CONFIG.cognitoAuthDomain}/oauth2/authorize?${loginQueryString}`
                }],
                'set-cookie': [
                    { key: 'set-cookie', value: `spa-auth-edge-nonce=${encodeURIComponent(state.nonce)}; ${CONFIG.cookieSettings.nonce}` },
                    { key: 'set-cookie', value: `spa-auth-edge-nonce-hmac=${encodeURIComponent(state.nonceHmac)}; ${CONFIG.cookieSettings.nonce}` },
                    { key: 'set-cookie', value: `spa-auth-edge-pkce=${encodeURIComponent(pkce)}; ${CONFIG.cookieSettings.nonce}` }
                ],
                ...CONFIG.cloudFrontHeaders,
            }
        }
        logger.debug('Returning response:\n', response);
        return response;
    }
}

function generatePkceVerifier() {
    const pkce = [...new Array(PKCE_LENGTH)].map(() => randomChoiceFromIndexable(SECRET_ALLOWED_CHARS)).join('');
    const verifier = {
        pkce,
        pkceHash: urlSafe.stringify(createHash('sha256')
            .update(pkce, 'utf8')
            .digest('base64')),
    };
    logger.debug('Generated PKCE verifier:\n', verifier);
    return verifier;
}

function generateNonce() {
    const randomString = [...new Array(NONCE_LENGTH)].map(() => randomChoiceFromIndexable(SECRET_ALLOWED_CHARS)).join('');
    const nonce = `${timestampInSeconds()}T${randomString}`;
    logger.debug('Generated new nonce:', nonce);
    return nonce;
}

function timestampInSeconds() {
    return Date.now() / 1000 | 0;
}

function randomChoiceFromIndexable(indexable: string) {
    if (indexable.length > 256) {
        throw new Error(`indexable is too large: ${indexable.length}`);
    }
    const chunks = Math.floor(256 / indexable.length);
    const firstBiassedIndex = indexable.length * chunks;
    let randomNumber: number;
    do {
        randomNumber = randomBytes(1)[0];
    } while (randomNumber >= firstBiassedIndex)
    const index = randomNumber % indexable.length;
    return indexable[index];
}

function signNonce(nonce: string, secret: string) {
    const digest = createHmac('sha256', secret).update(nonce).digest('base64').slice(0, NONCE_LENGTH);
    const signature = urlSafe.stringify(digest);
    logger.debug('Nonce signature:', signature);
    return signature;
}

function stateIsValid(state: State, secret: string) {
    const nonceTimestamp = parseInt(state.nonce.slice(0, state.nonce.indexOf('T')));
    if ((timestampInSeconds() - nonceTimestamp) > NONCE_MAX_AGE) {
        logger.debug('Nonce is too old to reuse:', nonceTimestamp, new Date(nonceTimestamp * 1000).toISOString());
        return false;
    }
    // Nonce should have the right signature: proving we were the ones generating it
    const calculatedHmac = signNonce(state.nonce, secret);
    if (calculatedHmac !== state.nonceHmac) {
        logger.warn('Nonce signature mismatch:', calculatedHmac, '!=', state.nonceHmac);
        return false;
    }
    logger.debug('State is valid');
    return true;
}

interface State {
    nonce: string;
    nonceHmac: string;
}

// Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { stringify as stringifyQueryString } from 'querystring';
import { createHash, randomBytes, createHmac } from 'crypto';
import { CloudFrontRequestHandler } from 'aws-lambda';
import { validate } from './validate-jwt';
import { getConfig, extractAndParseCookies, decodeToken, urlSafe, defaultCookieSettings } from '../shared/shared';

// Allowed characters per https://tools.ietf.org/html/rfc7636#section-4.1
const SECRET_ALLOWED_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
const PKCE_LENGTH = 43; // Should be between 43 and 128 - per spec
const NONCE_LENGTH = 16; // how many characters should your nonces be?
const CONFIG = getConfig();
const COOKIE_SETTING = CONFIG.cookieSettings.nonce || defaultCookieSettings[CONFIG.mode].nonce;

export const handler: CloudFrontRequestHandler = async (event) => {
    const request = event.Records[0].cf.request;
    const domainName = request.headers['host'][0].value;
    const requestedUri = `${request.uri}${request.querystring ? '?' + request.querystring : ''}`;
    let existingNonce: string | undefined = undefined;
    let existingPkce: string | undefined = undefined;
    try {
        const { tokenUserName, idToken, refreshToken, nonce, nonceHmac, pkce } = extractAndParseCookies(request.headers, CONFIG.clientId);
        if (!tokenUserName || !idToken) {
            throw new Error('No valid credentials present in cookies');
        }
        // Reuse existing nonce and pkce, be more lenient to users doing parallel sign-in's
        // But do make sure we were the ones who provided the nonce
        if (existingNonce && nonceHmac && existingPkce) {
            verifyNonceSignature(existingNonce, nonceHmac, CONFIG.nonceSigningSecret);
            existingNonce = nonce;
            existingPkce = pkce;
        }
        // If the token has expired or expires in less than 10 minutes and there is a refreshToken: refresh tokens
        const { exp } = decodeToken(idToken);
        if ((Date.now() / 1000) > exp - (60 * 10) && refreshToken) {
            const nonce = existingNonce || generateNonce();
            return {
                status: '307',
                statusDescription: 'Temporary Redirect',
                headers: {
                    'location': [{
                        key: 'location',
                        value: `https://${domainName}${CONFIG.redirectPathAuthRefresh}?${stringifyQueryString({ requestedUri, nonce })}`
                    }],
                    'set-cookie': [
                        { key: 'set-cookie', value: `spa-auth-edge-nonce=${encodeURIComponent(nonce)}; ${COOKIE_SETTING}` },
                        { key: 'set-cookie', value: `spa-auth-edge-nonce-hmac=${encodeURIComponent(signNonce(nonce, CONFIG.nonceSigningSecret))}; ${COOKIE_SETTING}` },
                    ],
                    ...CONFIG.cloudFrontHeaders,
                }
            }
        }
        // Check for valid a JWT. This throws an error if there's no valid JWT:
        await validate(idToken, CONFIG.tokenJwksUri, CONFIG.tokenIssuer, CONFIG.clientId);
        // Return the request unaltered to allow access to the resource:
        return request;

    } catch (err) {
        // Encode the state variable as base64 to avoid a bug in Cognito hosted UI when using multiple identity providers
        // Cognito decodes the URL, causing a malformed link due to the JSON string, and results in an empty 400 response from Cognito.
        const nonce = existingNonce || generateNonce();
        const pkceVerifier = generatePkceVerifier(existingPkce);
        const loginQueryString = stringifyQueryString({
            redirect_uri: `https://${domainName}${CONFIG.redirectPathSignIn}`,
            response_type: 'code',
            client_id: CONFIG.clientId,
            state: urlSafe.stringify(Buffer.from(JSON.stringify({ nonce, requestedUri })).toString('base64')),
            scope: CONFIG.oauthScopes.join(' '),
            code_challenge_method: 'S256',
            code_challenge: pkceVerifier.pkceHash,
        });
        return {
            status: '307',
            statusDescription: 'Temporary Redirect',
            headers: {
                'location': [{
                    key: 'location',
                    value: `https://${CONFIG.cognitoAuthDomain}/oauth2/authorize?${loginQueryString}`
                }],
                'set-cookie': [
                    { key: 'set-cookie', value: `spa-auth-edge-nonce=${encodeURIComponent(nonce)}; ${COOKIE_SETTING}` },
                    { key: 'set-cookie', value: `spa-auth-edge-nonce-hmac=${encodeURIComponent(signNonce(nonce, CONFIG.nonceSigningSecret))}; ${COOKIE_SETTING}` },
                    { key: 'set-cookie', value: `spa-auth-edge-pkce=${encodeURIComponent(pkceVerifier.pkce)}; ${COOKIE_SETTING}` }
                ],
                ...CONFIG.cloudFrontHeaders,
            }
        }
    }
}

function generatePkceVerifier(pkce?: string) {
    if (!pkce) {
        pkce = [...new Array(PKCE_LENGTH)].map(() => randomChoiceFromIndexable(SECRET_ALLOWED_CHARS)).join('');
    }
    return {
        pkce,
        pkceHash: urlSafe.stringify(createHash('sha256')
            .update(pkce, 'utf8')
            .digest('base64')),
    };
}

function generateNonce() {
    return [...new Array(NONCE_LENGTH)].map(() => randomChoiceFromIndexable(SECRET_ALLOWED_CHARS)).join('');
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
    return urlSafe.stringify(digest);
}

function verifyNonceSignature(nonce: string, signature: string, secret: string) {
    if (signNonce(nonce, secret) !== signature) {
        throw new Error("Invalid nonce signature");
    }
}

// Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { stringify as stringifyQueryString } from 'querystring';
import { createHash, randomBytes } from 'crypto';
import { CloudFrontRequestHandler } from 'aws-lambda';
import { validate } from './validate-jwt';
import { getConfig, extractAndParseCookies, decodeToken } from '../shared/shared';

const { clientId, oauthScopes, cognitoAuthDomain, redirectPathSignIn, redirectPathAuthRefresh,
    tokenIssuer, tokenJwksUri, cookieSettings, cloudFrontHeaders } = getConfig();

export const handler: CloudFrontRequestHandler = async (event) => {
    const request = event.Records[0].cf.request;
    const domainName = request.headers['host'][0].value;
    const requestedUri = `${request.uri}${request.querystring ? '?' + request.querystring : ''}`;
    const nonce = generateNonce();
    try {
        const { tokenUserName, idToken, refreshToken } = extractAndParseCookies(request.headers, clientId);
        if (!tokenUserName || !idToken) {
            throw new Error('No valid credentials present in cookies');
        }
        // If the token has (nearly) expired and there is a refreshToken: refresh tokens
        const { exp } = decodeToken(idToken);
        if ((Date.now() / 1000) - 60 > exp && refreshToken) {
            return {
                status: '307',
                statusDescription: 'Temporary Redirect',
                headers: {
                    'location': [{
                        key: 'location',
                        value: `https://${domainName}${redirectPathAuthRefresh}?${stringifyQueryString({ requestedUri, nonce })}`
                    }],
                    'set-cookie': [
                        { key: 'set-cookie', value: `spa-auth-edge-nonce=${encodeURIComponent(nonce)}; ${cookieSettings.nonce}` },
                    ],
                    ...cloudFrontHeaders,
                }
            }
        }
        // Check for valid a JWT. This throws an error if there's no valid JWT:
        await validate(idToken, tokenJwksUri, tokenIssuer, clientId);
        // Return the request unaltered to allow access to the resource:
        return request;

    } catch (err) {
        const { pkce, pkceHash } = generatePkceVerifier();
        const loginQueryString = stringifyQueryString({
            redirect_uri: `https://${domainName}${redirectPathSignIn}`,
            response_type: 'code',
            client_id: clientId,
            state: JSON.stringify({ nonce, requestedUri }),
            scope: oauthScopes.join(' '),
            code_challenge_method: 'S256',
            code_challenge: pkceHash,
        });
        return {
            status: '307',
            statusDescription: 'Temporary Redirect',
            headers: {
                'location': [{
                    key: 'location',
                    value: `https://${cognitoAuthDomain}/oauth2/authorize?${loginQueryString}`
                }],
                'set-cookie': [
                    { key: 'set-cookie', value: `spa-auth-edge-nonce=${encodeURIComponent(nonce)}; ${cookieSettings.nonce}` },
                    { key: 'set-cookie', value: `spa-auth-edge-pkce=${encodeURIComponent(pkce)}; ${cookieSettings.nonce}` }
                ],
                ...cloudFrontHeaders,
            }
        }
    }
}

// Allowed characters per https://tools.ietf.org/html/rfc7636#section-4.1
const PKCE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
const PKCE_LENGTH = 128; // recommended maximum length of pkce

function generatePkceVerifier() {
    const pkce = [...new Array(PKCE_LENGTH)].map(() => randomChoiceFromIndexable(PKCE_CHARS)).join('');
    return {
        pkce,
        pkceHash: createHash('sha256')
            .update(pkce, 'utf8')
            .digest('base64')
            .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_'),
    };
}

// Allowed cookie characters per https://www.ietf.org/rfc/rfc6265.txt
const NONCE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!#$%&'*+-.^_`|~";
const NONCE_LENGTH = 16; // how many characters should your nonces be?

function generateNonce() {
    return [...new Array(NONCE_LENGTH)].map(() => randomChoiceFromIndexable(NONCE_CHARS)).join('');
}

function randomChoiceFromIndexable(indexable: string | any[]) {
    const bytesNeeded = Math.ceil(indexable.length / 256);
    const chunks = Math.floor(256 / indexable.length) || 1;
    const maximum = indexable.length * chunks;
    let randomNumber = maximum;
    while (randomNumber >= maximum) {
        randomNumber = randomBytes(bytesNeeded).reduce((acc, byte) => acc + byte);
    }
    const index = randomNumber % indexable.length;
    return indexable[index];
}

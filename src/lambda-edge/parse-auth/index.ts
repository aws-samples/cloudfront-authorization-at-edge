// Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { parse as parseQueryString, stringify as stringifyQueryString } from 'querystring';
import { CloudFrontRequestHandler, CloudFrontRequest } from 'aws-lambda';
import { getConfig, extractAndParseCookies, getCookieHeaders, httpPostWithRetry, createErrorHtml, urlSafe } from '../shared/shared';

const CONFIG = getConfig();

export const handler: CloudFrontRequestHandler = async (event) => {
    const request = event.Records[0].cf.request;
    const domainName = request.headers['host'][0].value;
    let redirectedFromUri = `https://${domainName}`;

    try {
        const { code, pkce, requestedUri } = validateQueryStringAndCookies(request);
        redirectedFromUri += requestedUri;

        const body = stringifyQueryString({
            grant_type: 'authorization_code',
            client_id: CONFIG.clientId,
            redirect_uri: `https://${domainName}${CONFIG.redirectPathSignIn}`,
            code,
            code_verifier: pkce
        });

        const headers: { 'Content-Type': string, Authorization?: string } = { 'Content-Type': 'application/x-www-form-urlencoded' }

        if (CONFIG.clientSecret) {
            const encodedSecret = Buffer.from(`${CONFIG.clientId}:${CONFIG.clientSecret}`).toString('base64');
            headers.Authorization = `Basic ${encodedSecret}`;
        }

        const res = await httpPostWithRetry(`https://${CONFIG.cognitoAuthDomain}/oauth2/token`, body, { headers });
        return {
            status: '307',
            statusDescription: 'Temporary Redirect',
            headers: {
                'location': [{
                    key: 'location',
                    value: redirectedFromUri,
                }],
                'set-cookie': getCookieHeaders({
                    tokens: res.data, domainName, explicitCookieSettings: CONFIG.cookieSettings, ...CONFIG
                }),
                ...CONFIG.cloudFrontHeaders,
            }
        };
    } catch (err) {
        return {
            body: createErrorHtml('Bad Request', err.toString(), redirectedFromUri),
            status: '400',
            headers: {
                ...CONFIG.cloudFrontHeaders,
                'content-type': [{
                    key: 'Content-Type',
                    value: 'text/html; charset=UTF-8',
                }]
            }
        };
    }
}

function validateQueryStringAndCookies(request: CloudFrontRequest) {
    const { code, state, error: cognitoError, error_description } = parseQueryString(request.querystring);
    if (cognitoError) {
        throw new Error(`[Cognito] ${cognitoError}: ${error_description}`);
    }
    if (!code || !state || typeof code !== 'string' || typeof state !== 'string') {
        throw new Error(
            ['Invalid query string. Your query string does not include parameters "state" and "code".',
                'This can happen if your authentication attempt did not originate from this site - this is not allowed'].join(' ')
        );
    }
    let parsedState: { nonce?: string, requestedUri?: string };
    try {
        parsedState = JSON.parse(Buffer.from(urlSafe.parse(state), 'base64').toString());
    } catch {
        throw new Error('Invalid query string. Your query string does not include a valid "state" parameter');
    }
    if (!parsedState.requestedUri || !parsedState.nonce) {
        throw new Error('Invalid query string. Your query string does not include a valid "state" parameter');
    }
    const { nonce: originalNonce, pkce } = extractAndParseCookies(request.headers, CONFIG.clientId);
    if (!parsedState.nonce || !originalNonce || parsedState.nonce !== originalNonce) {
        if (!originalNonce) {
            throw new Error('Your browser didn\'t send the nonce cookie along, but it is required for security (prevent CSRF).');
        }
        throw new Error('Nonce mismatch. This can happen if you start multiple authentication attempts in parallel (e.g. in separate tabs)');
    }
    return { code, pkce, requestedUri: parsedState.requestedUri || '' };
}

// Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { parse as parseQueryString, stringify as stringifyQueryString } from 'querystring';
import { CloudFrontRequestHandler } from 'aws-lambda';
import { getConfig, extractAndParseCookies, getCookieHeaders, httpPostWithRetry, createErrorHtml } from '../shared/shared';

const { clientId, oauthScopes, cognitoAuthDomain, redirectPathSignIn, cookieSettings, cloudFrontHeaders, clientSecret } = getConfig();

export const handler: CloudFrontRequestHandler = async (event) => {
    const request = event.Records[0].cf.request;
    const domainName = request.headers['host'][0].value;
    let redirectedFromUri = `https://${domainName}`;

    try {
        const { code, state, error: cognitoError, error_description } = parseQueryString(request.querystring);
        if (cognitoError) {
            throw new Error(`[Cognito] ${[cognitoError, error_description].join(': ')}`);
        }
        if (!code || !state || typeof code !== 'string' || typeof state !== 'string') {
            throw new Error('Invalid query string. Your query string should include parameters "state" and "code"');
        }
        const { nonce: currentNonce, requestedUri } = JSON.parse(Buffer.from(state, 'base64').toString());
        redirectedFromUri += requestedUri || '';
        const { nonce: originalNonce, pkce } = extractAndParseCookies(request.headers, clientId);
        if (!currentNonce || !originalNonce || currentNonce !== originalNonce) {
            if (!originalNonce) {
                throw new Error('Your browser didn\'t send the nonce cookie along, but it is required for security (prevent CSRF).');
            }
            throw new Error('Nonce mismatch');
        }
        const body = stringifyQueryString({
            grant_type: 'authorization_code',
            client_id: clientId,
            redirect_uri: `https://${domainName}${redirectPathSignIn}`,
            code,
            code_verifier: pkce
        });

        const headers: { 'Content-Type': string, Authorization?: string } = { 'Content-Type': 'application/x-www-form-urlencoded' }

        if(clientSecret) {
            const encodedSecret = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
            headers['Authorization'] = `Basic ${encodedSecret}`
        }

        const res = await httpPostWithRetry(`https://${cognitoAuthDomain}/oauth2/token`, body, { headers } );
        return {
            status: '307',
            statusDescription: 'Temporary Redirect',
            headers: {
                'location': [{
                    key: 'location',
                    value: redirectedFromUri,
                }],
                'set-cookie': getCookieHeaders(clientId, oauthScopes, res.data, domainName, cookieSettings),
                ...cloudFrontHeaders,
            }
        };
    } catch (err) {
        return {
            body: createErrorHtml('Bad Request', err.toString(), redirectedFromUri),
            status: '400',
            headers: {
                ...cloudFrontHeaders,
                'content-type': [{
                    key: 'Content-Type',
                    value: 'text/html; charset=UTF-8',
                }]
            }
        };
    }
}

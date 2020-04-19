// Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { parse as parseQueryString, stringify as stringifyQueryString } from 'querystring';
import { CloudFrontRequestHandler } from 'aws-lambda';
import { getConfig, extractAndParseCookies, getCookieHeaders, httpPostWithRetry, createErrorHtml } from '../shared/shared';

const { clientId, oauthScopes, cognitoAuthDomain, cookieSettings, mode, cloudFrontHeaders, clientSecret } = getConfig();


export const handler: CloudFrontRequestHandler = async (event) => {
    const request = event.Records[0].cf.request;
    const domainName = request.headers['host'][0].value;
    let redirectedFromUri = `https://${domainName}`;

    try {
        const { requestedUri, nonce: currentNonce } = parseQueryString(request.querystring);
        redirectedFromUri += requestedUri || '';
        const { idToken, accessToken, refreshToken, nonce: originalNonce } = extractAndParseCookies(request.headers, clientId);

        validateRefreshRequest(currentNonce, originalNonce, idToken, accessToken, refreshToken);

        let headers: { 'Content-Type': string, Authorization?: string } = { 'Content-Type': 'application/x-www-form-urlencoded' }

        if (clientSecret !== '') {
            const encodedSecret = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
            headers['Authorization'] = `Basic ${encodedSecret}`
        }

        let tokens = { id_token: idToken!, access_token: accessToken!, refresh_token: refreshToken! };
        try {
            const body = stringifyQueryString({
                grant_type: 'refresh_token',
                client_id: clientId,
                refresh_token: refreshToken,
            });
            const res = await httpPostWithRetry(`https://${cognitoAuthDomain}/oauth2/token`, body, { headers });
            tokens.id_token = res.data.id_token;
            tokens.access_token = res.data.access_token;
        } catch (err) {
            tokens.refresh_token = '';
        }
        return {
            status: '307',
            statusDescription: 'Temporary Redirect',
            headers: {
                'location': [{
                    key: 'location',
                    value: redirectedFromUri,
                }],
                'set-cookie': getCookieHeaders({
                    clientId, oauthScopes, tokens, domainName, explicitCookieSettings: cookieSettings, mode
                }),
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
            },
        };
    }
}

function validateRefreshRequest(currentNonce?: string | string[], originalNonce?: string, idToken?: string, accessToken?: string, refreshToken?: string) {
    if (!originalNonce) {
        throw new Error('Your browser didn\'t send the nonce cookie along, but it is required for security (prevent CSRF).');
    } else if (currentNonce !== originalNonce) {
        throw new Error('Nonce mismatch');
    }
    Object.entries({ idToken, accessToken, refreshToken }).forEach(([tokenType, token]) => {
        if (!token) {
            throw new Error(`Missing ${tokenType}`);
        }
    });
}

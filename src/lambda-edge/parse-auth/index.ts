// Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { parse as parseQueryString, stringify as stringifyQueryString } from 'querystring';
import { CloudFrontRequestHandler } from 'aws-lambda';
import axios from 'axios';
import { Agent } from 'https';
import { getConfig, extractAndParseCookies, getCookieHeaders } from '../shared/shared';

const axiosInstance = axios.create({
    httpsAgent: new Agent({ keepAlive: true }),
});

const { clientId, oauthScopes, cognitoAuthDomain, redirectPathSignIn, cookieSettings, cloudFrontHeaders } = getConfig();

export const handler: CloudFrontRequestHandler = async (event) => {
    const request = event.Records[0].cf.request;
    const domainName = request.headers['host'][0].value;
    const { code, state } = parseQueryString(request.querystring);

    try {
        if (!code || !state || typeof code !== 'string' || typeof state !== 'string') {
            throw new Error('invalid query string');
        }
        const { nonce: currentNonce, requestedUri } = JSON.parse(state);
        const { nonce: originalNonce, pkce } = extractAndParseCookies(request.headers, clientId);
        if (!currentNonce || !originalNonce || currentNonce !== originalNonce) {
            throw new Error(`nonce mismatch! expected: "${originalNonce}" got: "${currentNonce}"`);
        }
        const body = stringifyQueryString({
            grant_type: 'authorization_code',
            client_id: clientId,
            redirect_uri: `https://${domainName}${redirectPathSignIn}`,
            code,
            code_verifier: pkce
        });
        const res = await axiosInstance.post(`https://${cognitoAuthDomain}/oauth2/token`, body, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
        return {
            status: '307',
            statusDescription: 'Temporary Redirect',
            headers: {
                'location': [{
                    key: 'location',
                    value: `https://${domainName}${requestedUri}`,
                }],
                'set-cookie': getCookieHeaders(clientId, oauthScopes, res.data, domainName, cookieSettings),
                ...cloudFrontHeaders,
            }
        };
    } catch (err) {
        return {
            body: 'Bad Request',
            status: '400', // Note: do not send 403 (!) as we have CloudFront send back index.html for 403's to enable SPA-routing
            statusDescription: 'Bad Request',
            headers: cloudFrontHeaders,
        };
    }
}

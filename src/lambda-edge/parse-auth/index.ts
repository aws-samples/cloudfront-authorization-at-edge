// Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { parse as parseQueryString, stringify as stringifyQueryString } from 'querystring';
import { CloudFrontRequestHandler } from 'aws-lambda';
import { getConfig, extractAndParseCookies, getCookieHeaders, httpPostWithRetry } from '../shared/shared';

const { clientId, oauthScopes, cognitoAuthDomain, redirectPathSignIn, cookieSettings, cloudFrontHeaders } = getConfig();

export const handler: CloudFrontRequestHandler = async (event) => {
    const request = event.Records[0].cf.request;
    const domainName = request.headers['host'][0].value;
    const { code, state } = parseQueryString(request.querystring);

    let redirectedFromUri = `https://${domainName}`;

    try {
        if (!code || !state || typeof code !== 'string' || typeof state !== 'string') {
            throw new Error('Invalid query string. Your query string should include parameters "state" and "code"');
        }
        const { nonce: currentNonce, requestedUri } = JSON.parse(state);
        redirectedFromUri += requestedUri;
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

        const res = await httpPostWithRetry(`https://${cognitoAuthDomain}/oauth2/token`, body, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
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
            body: getHtml('Bad Request', err.toString(), redirectedFromUri),
            status: '400', // Note: do not send 403 (!) as we have CloudFront send back index.html for 403's to enable SPA-routing
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

function getHtml(title: string, message: string, tryAgainHref: string) {
    return `<!DOCTYPE html>
<html lang="en">
    <head>
        <meta charset="utf-8">
        <title>${title}</title>
    </head>
    <body>
        <h1>${title}</h1>
        <p><b>ERROR:</b> ${message}</p>
        <a href="${tryAgainHref}">Try again</a>
    </body>
</html>`;
}

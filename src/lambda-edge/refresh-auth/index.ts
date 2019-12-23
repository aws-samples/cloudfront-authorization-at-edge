// Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { parse as parseQueryString, stringify as stringifyQueryString } from 'querystring';
import { CloudFrontRequestHandler } from 'aws-lambda';
import { getConfig, extractAndParseCookies, getCookieHeaders, httpPostWithRetry, createErrorHtml } from '../shared/shared';

const { clientId, oauthScopes, cognitoAuthDomain, cookieSettings, cloudFrontHeaders } = getConfig();

function isInvalidRefreshRequest(currentNonce?: string | string[], originalNonce?: string, idToken?: string, accessToken?: string, refreshToken?: string) {
    return !(currentNonce && originalNonce && currentNonce === originalNonce
        && idToken && accessToken && refreshToken);
}

export const handler: CloudFrontRequestHandler = async (event) => {
    const request = event.Records[0].cf.request;
    const domainName = request.headers['host'][0].value;
    const { requestedUri, nonce: currentNonce } = parseQueryString(request.querystring);
    const { idToken, accessToken, refreshToken, nonce: originalNonce } = extractAndParseCookies(request.headers, clientId);

    if (isInvalidRefreshRequest(currentNonce, originalNonce, idToken, accessToken, refreshToken)) {
        let message = 'Invalid refresh request';
        if (!originalNonce) {
            message = 'Your browser didn\'t send the nonce cookie along, but it is required for security (prevent CSRF).';
        }
        return {
            body: createErrorHtml('Bad Request', message, `https://${domainName}${requestedUri}`),
            status: '400', // Note: do not send 403 (!) as we have CloudFront send back index.html for 403's to enable SPA-routing 
            headers: {
                ...cloudFrontHeaders,
                'content-type': [{
                    key: 'Content-Type',
                    value: 'text/html; charset=UTF-8',
            }]},
        };
    }

    let tokens = { id_token: idToken!, access_token: accessToken!, refresh_token: refreshToken! };
    try {
        const body = stringifyQueryString({
            grant_type: 'refresh_token',
            client_id: clientId,
            refresh_token: refreshToken,
        });
        const res = await httpPostWithRetry(`https://${cognitoAuthDomain}/oauth2/token`, body, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
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
                value: `https://${domainName}${requestedUri}`,
            }],
            'set-cookie': getCookieHeaders(clientId, oauthScopes, tokens, domainName, cookieSettings),
            ...cloudFrontHeaders,
        }
    };
}

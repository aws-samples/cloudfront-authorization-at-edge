// Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { stringify as stringifyQueryString } from 'querystring';
import { CloudFrontRequestHandler } from 'aws-lambda';
import { getConfig, extractAndParseCookies, generateCookieHeaders, createErrorHtml } from '../shared/shared';

const CONFIG = getConfig();

export const handler: CloudFrontRequestHandler = async (event) => {
    const request = event.Records[0].cf.request;
    const domainName = request.headers['host'][0].value;
    const { idToken, accessToken, refreshToken } = extractAndParseCookies(request.headers, CONFIG.clientId);

    if (!idToken) {
        return {
            body: createErrorHtml('Bad Request', "You are already signed out", `https://${domainName}`),
            status: '400',
            headers: {
                ...CONFIG.cloudFrontHeaders,
                'content-type': [{
                    key: 'Content-Type',
                    value: 'text/html; charset=UTF-8',
                }]
            },
        };
    }

    let tokens = { id_token: idToken!, access_token: accessToken!, refresh_token: refreshToken! };
    const qs = {
        logout_uri: `https://${domainName}${CONFIG.redirectPathSignOut}`,
        client_id: CONFIG.clientId,
    };

    return {
        status: '307',
        statusDescription: 'Temporary Redirect',
        headers: {
            'location': [{
                key: 'location',
                value: `https://${CONFIG.cognitoAuthDomain}/logout?${stringifyQueryString(qs)}`,
            }],
            'set-cookie': generateCookieHeaders.signOut({
                tokens, domainName, ...CONFIG
            }),
            ...CONFIG.cloudFrontHeaders,
        }
    };
}

// Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { stringify as stringifyQueryString } from 'querystring';
import { CloudFrontRequestHandler } from 'aws-lambda';
import { getConfig, extractAndParseCookies, getCookieHeaders } from '../shared/shared';

const { clientId, oauthScopes, cognitoAuthDomain, cookieSettings, cloudFrontHeaders, redirectPathSignOut } = getConfig();

export const handler: CloudFrontRequestHandler = async (event) => {
    const request = event.Records[0].cf.request;
    const domainName = request.headers['host'][0].value;
    const { idToken, accessToken, refreshToken } = extractAndParseCookies(request.headers, clientId);

    if (!idToken) {
        return {
            body: 'Bad Request',
            status: '400',
            statusDescription: 'Bad Request',
            headers: cloudFrontHeaders,
        };
    }

    let tokens = { id_token: idToken!, access_token: accessToken!, refresh_token: refreshToken };
    const qs = {
        logout_uri: `https://${domainName}${redirectPathSignOut}`,
        client_id: clientId,
    };

    return {
        status: '307',
        statusDescription: 'Temporary Redirect',
        headers: {
            'location': [{
                key: 'location',
                value: `https://${cognitoAuthDomain}/logout?${stringifyQueryString(qs)}`,
            }],
            'set-cookie': getCookieHeaders(clientId, oauthScopes, tokens, domainName, cookieSettings, true),
            ...cloudFrontHeaders,
        }
    };
}

// Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

jest.mock('../src/lambda-edge/shared/logger');
import Logger from '../src/lambda-edge/shared/logger';

jest.mock('../src/lambda-edge/shared/shared');
const shared = require('../src/lambda-edge/shared/shared');

jest.mock('querystring');
const querystring = require('querystring');

import { CloudFrontRequestEvent } from 'aws-lambda/trigger/cloudfront-request';
import * as refreshAuth from '../src/lambda-edge/refresh-auth/index';

beforeEach(() => {
    jest.clearAllMocks();
    const config = {
        userPoolId: 'us-east-1_zx1asrpUSS',
        clientId: '7brfkhdsdhoqa34941ghu78ad8n',
        oauthScopes: ['openid'],
        cognitoAuthDomain: 'auth.us-east-1.demo.aws.com',
        redirectPathSignIn: '/parseauth',
        redirectPathSignOut: '/',
        redirectPathAuthRefresh: '/refreshauth',
        cookieSettings: {
            idToken: 'Path=/; Secure; SameSite=Lax',
            accessToken: 'Path=/; Secure; SameSite=Lax',
            refreshToken: 'Path=/; Secure; SameSite=Lax',
            nonce: 'Path=/; Secure; HttpOnly; Max-Age=300; SameSite=Lax',
        },
        mode: 'spaMode',
        cloudFrontHeaders: {
            'Content-Security-Policy-Report-Only':
                "default-src https://demo.aws.com; img-src 'self' https://demo.aws.com; script-src 'self' https://demo.aws.com; style-src 'self'; object-src 'none' https://demo.aws.com; connect-src 'self' https://*.amazonaws.com https://*.amazoncognito.com https://*.demo.aws.com https://demo.aws.com",
            'Strict-Transport-Security': 'max-age=31536000; includeSubdomains; preload',
            'Referrer-Policy': 'same-origin',
            'X-XSS-Protection': '1; mode=block',
            'X-Frame-Options': 'DENY',
            'X-Content-Type-Options': 'nosniff',
        },
        logger: new Logger(40),
        clientSecret: 'clientSecret',
        nonceMaxAge: 20,
    };

    shared.getConfig.mockImplementation(() => {
        return config;
    });

    const cookie = {
        tokenUserName: 'tokenUserName',
        idToken: 'idToken',
        accessToken: 'accessToken',
        refreshToken: 'refreshToken',
        scopes: 'scopes',
        nonce: 'test_nonce',
        pkce: 'pkce',
    };
    shared.extractAndParseCookies.mockImplementation(() => {
        return cookie;
    });

    querystring.parse.mockImplementation(() => {
        return { requestedUri: 'requestedUri', nonce: 'test_nonce' };
    });

    querystring.stringify.mockImplementation(() => {
        return 'grant_type=refresh_token&client_id=client_id&refresh_token=refreshToken';
    });
});

afterEach(() => {
    jest.resetAllMocks();
});

describe('lambda-edge', () => {
    //  viewRequest grabbed from here
    // https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/lambda-event-structure.html#lambda-event-structure-request
    const viewRequest: CloudFrontRequestEvent = {
        Records: [
            {
                cf: {
                    config: {
                        distributionDomainName: 'd111111abcdef8.cloudfront.net',
                        distributionId: 'EDFDVBD6EXAMPLE',
                        eventType: 'viewer-request',
                        requestId: '4TyzHTaYWb1GX1qTfsHhEqV6HUDd_BzoBZnwfnvQc_1oF26ClkoUSEQ==',
                    },
                    request: {
                        clientIp: '203.0.113.178',
                        headers: {
                            host: [
                                {
                                    key: 'Host',
                                    value: 'd111111abcdef8.cloudfront.net',
                                },
                            ],
                            'user-agent': [
                                {
                                    key: 'User-Agent',
                                    value: 'curl/7.66.0',
                                },
                            ],
                            accept: [
                                {
                                    key: 'accept',
                                    value: '*/*',
                                },
                            ],
                        },
                        method: 'GET',
                        querystring: '',
                        uri: '/',
                    },
                },
            },
        ],
    };

    it('refresh-auth good request', async () => {
        shared.httpPostWithRetry.mockResolvedValue({
            status: '200',
            headers: 'headers',
            data: {
                id_token: 'idToken',
                access_token: 'accessToken',
                refresh_token: 'refreshToken',
            },
        });

        const result = await refreshAuth.handler(viewRequest, Object(), function (_err, data) {
            return data;
        });
        const response = JSON.parse(JSON.stringify(result));
        expect(response.status).toBe('307');
    });

    it('refresh-auth http post with retry fail', async () => {
        shared.httpPostWithRetry.mockRejectedValue('HTTP POST to url failed');

        const result = await refreshAuth.handler(viewRequest, Object(), function (_err, data) {
            return data;
        });
        const response = JSON.parse(JSON.stringify(result));
        expect(response.status).toBe('307');
    });

    it("refresh-auth bad request because nonce don't match", async () => {
        querystring.parse.mockImplementation(() => {
            return { requestedUri: 'requestedUri', nonce: 'wrong_nonce' };
        });

        const result = await refreshAuth.handler(viewRequest, Object(), function (_err, data) {
            return data;
        });
        const response = JSON.parse(JSON.stringify(result));
        expect(response.status).toBe('200');
    });

    it("refresh-auth bad request because browser didn't send the nonce cookie along", async () => {
        const cookie = {
            tokenUserName: 'tokenUserName',
            idToken: 'idToken',
            accessToken: 'accessToken',
            refreshToken: 'refreshToken',
            scopes: 'scopes',
            pkce: 'pkce',
        };
        shared.extractAndParseCookies.mockImplementation(() => {
            return cookie;
        });

        const result = await refreshAuth.handler(viewRequest, Object(), function (_err, data) {
            return data;
        });
        const response = JSON.parse(JSON.stringify(result));
        expect(response.status).toBe('200');
    });

    it('refresh-auth bad request because one of the cookie missing', async () => {
        const cookie = {
            tokenUserName: 'tokenUserName',
            idToken: 'idToken',
            accessToken: 'accessToken',
            scopes: 'scopes',
            nonce: 'test_nonce',
            pkce: 'pkce',
        };
        shared.extractAndParseCookies.mockImplementation(() => {
            return cookie;
        });

        const result = await refreshAuth.handler(viewRequest, Object(), function (_err, data) {
            return data;
        });
        const response = JSON.parse(JSON.stringify(result));
        expect(response.status).toBe('200');
    });
});

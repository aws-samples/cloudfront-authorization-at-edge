// Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

jest.mock('../src/lambda-edge/shared/logger');
import Logger from '../src/lambda-edge/shared/logger';

jest.mock('../src/lambda-edge/shared/shared');
const shared = require('../src/lambda-edge/shared/shared');

jest.mock('../src/lambda-edge/shared/validate-jwt');
const validateJwt = require('../src/lambda-edge/shared/validate-jwt');

jest.mock('querystring');
const querystring = require('querystring');

import { CloudFrontRequestEvent } from 'aws-lambda/trigger/cloudfront-request';
import * as checkAuth from '../src/lambda-edge/check-auth/index';

beforeEach(() => {
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
        nonceLength: 16,
        secretAllowedCharacters: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~',
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
        nonce: '10Test',
        pkce: 'pkce',
        nonceHmac: 'original_nonceHmac',
    };
    shared.extractAndParseCookies.mockImplementation(() => {
        return cookie;
    });

    querystring.parse.mockImplementation(() => {
        return { code: 'code', state: 'state' };
    });

    querystring.stringify.mockImplementation(() => {
        return 'grant_type=authorization_code&client_id=clientId&redirect_uri=https%3A%2F%2FdomainName%2FredirectPathSignIn&code=code&code_verifier=pkce';
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

    it('check-auth with no idToken', async () => {
        const cookie = {
            tokenUserName: 'tokenUserName',
            scopes: 'scopes',
            nonce: '10Test',
            pkce: 'pkce',
            nonceHmac: 'original_nonceHmac',
        };
        shared.extractAndParseCookies.mockImplementation(() => {
            return cookie;
        });

        shared.sign.mockImplementation(() => {
            return 'original_nonceHmac';
        });

        const result = await checkAuth.handler(viewRequest, Object(), function (_err, data) {
            return data;
        });

        const response = JSON.parse(JSON.stringify(result));
        expect(response.status).toBe('307');
    });

    it('check-auth redirect when token expires and refresh token exists', async () => {
        shared.decodeToken.mockImplementation(() => {
            return { exp: Date.now() / 1000 - 60 * 20 };
        });

        const result = await checkAuth.handler(viewRequest, Object(), function (_err, data) {
            return data;
        });

        const response = JSON.parse(JSON.stringify(result));
        expect(response.status).toBe('307');
    });

    it('check-auth return the request unaltered to allow access to the resource', async () => {
        shared.decodeToken.mockImplementation(() => {
            return { exp: Date.now() / 1000 + 60 * 20 };
        });

        const result = await checkAuth.handler(viewRequest, Object(), function (_err, data) {
            return data;
        });

        expect(result).toBe(viewRequest.Records[0].cf.request);
    });

    it('check-auth invalid JWT token', async () => {
        shared.decodeToken.mockImplementation(() => {
            return { exp: Date.now() / 1000 + 60 * 20 };
        });

        validateJwt.validate.mockImplementation(() => {
            throw new Error('Cannot parse JWT token');
        });

        const result = await checkAuth.handler(viewRequest, Object(), function (_err, data) {
            return data;
        });

        const response = JSON.parse(JSON.stringify(result));
        expect(response.status).toBe('307');
    });
});

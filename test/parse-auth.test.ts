// Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

jest.mock('../src/lambda-edge/shared/logger');
import Logger from '../src/lambda-edge/shared/logger';

jest.mock('../src/lambda-edge/shared/shared');
const shared = require('../src/lambda-edge/shared/shared');

jest.mock('../src/lambda-edge/shared/validate-jwt');
const validate = require('../src/lambda-edge/shared/validate-jwt');

jest.mock('querystring');
const querystring = require('querystring');

import { CloudFrontRequestEvent } from 'aws-lambda/trigger/cloudfront-request';
import * as parseAuth from '../src/lambda-edge/parse-auth/index';

beforeEach(() => {
    jest.resetAllMocks();
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

    it('parse-auth good request', async () => {
        //Buffer.from response on urlSafe.parse(state)
        Buffer.from = jest.fn().mockImplementation(() => {
            return JSON.stringify({
                requestedUri: '/requestedUri',
                nonce: '10Test',
            });
        });
        shared.timestampInSeconds.mockImplementation(() => {
            return 25;
        });

        shared.sign.mockImplementation(() => {
            return 'original_nonceHmac';
        });

        shared.httpPostWithRetry.mockResolvedValue({
            status: '200',
            headers: 'headers',
            data: {
                id_token: 'idToken',
                access_token: 'accessToken',
                refresh_token: 'refreshToken',
            },
        });
        const result = await parseAuth.handler(viewRequest, Object(), function (_err, data) {
            return data;
        });

        const response = JSON.parse(JSON.stringify(result));
        expect(response.status).toBe('307');
    });

    it('parse-auth when there is an ID token - maybe the user signed in already', async () => {
        const result = await parseAuth.handler(viewRequest, Object(), function (_err, data) {
            return data;
        });

        const response = JSON.parse(JSON.stringify(result));
        expect(response.status).toBe('307');
    });

    it('parse-auth when there is an ID token - but token validation fails', async () => {
        validate.validate.mockImplementation(() => {
            throw new Error('Token validation fails');
        });
        const result = await parseAuth.handler(viewRequest, Object(), function (_err, data) {
            return data;
        });

        const response = JSON.parse(JSON.stringify(result));
        expect(response.status).toBe('200');
    });

    it('parse-auth cognito error', async () => {
        const cookie = {
            tokenUserName: 'tokenUserName',
        };
        shared.extractAndParseCookies.mockImplementation(() => {
            return cookie;
        });

        querystring.parse.mockImplementation(() => {
            return { error: 'Error message description' };
        });

        const result = await parseAuth.handler(viewRequest, Object(), function (_err, data) {
            return data;
        });

        const response = JSON.parse(JSON.stringify(result));
        expect(response.status).toBe('200');
    });

    it('parse-auth querystring without code and state', async () => {
        const cookie = {
            tokenUserName: 'tokenUserName',
        };
        shared.extractAndParseCookies.mockImplementation(() => {
            return cookie;
        });

        querystring.parse.mockImplementation(() => {
            return {};
        });

        const result = await parseAuth.handler(viewRequest, Object(), function (_err, data) {
            return data;
        });

        const response = JSON.parse(JSON.stringify(result));
        expect(response.status).toBe('200');
    });

    it('parse-auth querystring when state is not JSON string', async () => {
        const cookie = {
            tokenUserName: 'tokenUserName',
        };
        shared.extractAndParseCookies.mockImplementation(() => {
            return cookie;
        });

        querystring.parse.mockImplementation(() => {
            return { code: 'code', state: ['state'] };
        });

        const result = await parseAuth.handler(viewRequest, Object(), function (_err, data) {
            return data;
        });

        const response = JSON.parse(JSON.stringify(result));
        expect(response.status).toBe('200');
    });

    it('parse-auth querystring does not include right pieces', async () => {
        const cookie = {
            tokenUserName: 'tokenUserName',
        };
        shared.extractAndParseCookies.mockImplementation(() => {
            return cookie;
        });

        Buffer.from = jest.fn().mockImplementation(() => {
            return JSON.stringify({
                requestedUri: '/requestedUri',
            });
        });

        const result = await parseAuth.handler(viewRequest, Object(), function (_err, data) {
            return data;
        });

        const response = JSON.parse(JSON.stringify(result));
        expect(response.status).toBe('200');
    });

    it("parse-auth browser doesn't send nonce along", async () => {
        const cookie = {
            tokenUserName: 'tokenUserName',
        };
        shared.extractAndParseCookies.mockImplementation(() => {
            return cookie;
        });

        Buffer.from = jest.fn().mockImplementation(() => {
            return JSON.stringify({
                requestedUri: 'requestedUri',
                nonce: '10Test',
            });
        });

        const result = await parseAuth.handler(viewRequest, Object(), function (_err, data) {
            return data;
        });

        const response = JSON.parse(JSON.stringify(result));
        expect(response.status).toBe('200');
    });

    it("parse-auth nonce doesn't match", async () => {
        const cookie = {
            tokenUserName: 'tokenUserName',
            nonce: '10Test',
            pkce: 'pkce',
            nonceHmac: 'original_nonceHmac',
        };
        shared.extractAndParseCookies.mockImplementation(() => {
            return cookie;
        });

        Buffer.from = jest.fn().mockImplementation(() => {
            return JSON.stringify({
                requestedUri: 'requestedUri',
                nonce: 'wrong_nonce',
            });
        });

        const result = await parseAuth.handler(viewRequest, Object(), function (_err, data) {
            return data;
        });

        const response = JSON.parse(JSON.stringify(result));
        expect(response.status).toBe('200');
    });

    it('parse-auth request without pkce', async () => {
        const cookie = {
            tokenUserName: 'tokenUserName',
            scopes: 'scopes',
            nonce: '10Test',
            nonceHmac: 'original_nonceHmac',
        };
        shared.extractAndParseCookies.mockImplementation(() => {
            return cookie;
        });

        Buffer.from = jest.fn().mockImplementation(() => {
            return JSON.stringify({
                requestedUri: '/requestedUri',
                nonce: '10Test',
            });
        });

        const result = await parseAuth.handler(viewRequest, Object(), function (_err, data) {
            return data;
        });

        const response = JSON.parse(JSON.stringify(result));
        expect(response.status).toBe('200');
    });

    it('parse-auth request when nonce is too old', async () => {
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

        Buffer.from = jest.fn().mockImplementation(() => {
            return JSON.stringify({
                requestedUri: '/requestedUri',
                nonce: '10Test',
            });
        });

        shared.timestampInSeconds.mockImplementation(() => {
            return 35;
        });

        const result = await parseAuth.handler(viewRequest, Object(), function (_err, data) {
            return data;
        });

        const response = JSON.parse(JSON.stringify(result));
        expect(response.status).toBe('200');
    });

    it('parse-auth request when nonce is too old', async () => {
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

        Buffer.from = jest.fn().mockImplementation(() => {
            return JSON.stringify({
                requestedUri: '/requestedUri',
                nonce: '10Test',
            });
        });

        shared.timestampInSeconds.mockImplementation(() => {
            return 25;
        });

        shared.sign.mockImplementation(() => {
            return 'incorrect_nonceHmac';
        });
        const result = await parseAuth.handler(viewRequest, Object(), function (_err, data) {
            return data;
        });

        const response = JSON.parse(JSON.stringify(result));
        expect(response.status).toBe('200');
    });

    it('parse-auth when http post retry failed', async () => {
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

        //Buffer.from response on urlSafe.parse(state)
        Buffer.from = jest.fn().mockImplementation(() => {
            return JSON.stringify({
                requestedUri: '/requestedUri',
                nonce: '10Test',
            });
        });

        shared.timestampInSeconds.mockImplementation(() => {
            return 25;
        });

        shared.sign.mockImplementation(() => {
            return 'original_nonceHmac';
        });

        shared.httpPostWithRetry.mockRejectedValue('http post retry failed');

        const result = await parseAuth.handler(viewRequest, Object(), function (_err, data) {
            return data;
        });

        const response = JSON.parse(JSON.stringify(result));
        expect(response.status).toBe('200');
    });
});

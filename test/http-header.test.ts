// Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

jest.mock('../src/lambda-edge/shared/logger');
import Logger from '../src/lambda-edge/shared/logger';

jest.mock('../src/lambda-edge/shared/shared');
const shared = require('../src/lambda-edge/shared/shared');

import { CloudFrontResponseEvent } from 'aws-lambda/trigger/cloudfront-response';
import * as httpHeaders from '../src/lambda-edge/http-headers/index';

beforeEach(() => {
    const config = {
        cloudFrontHeaders: {
            'Content-Security-Policy-Report-Only':
                "default-src https://demo.vdlkrt.aws.com img-src 'self' https://demo.vdlkrt.aws.com script-src 'self' https://demo.vdlkrt.aws.com style-src 'self'; object-src 'none' https://demo.vdlkrt.aws.com connect-src 'self' https://*.amazonaws.com https://*.amazoncognito.com https://*.demo.vdlkrt.aws.com https://demo.vdlkrt.aws.com",
            'Strict-Transport-Security': 'max-age=31536000; includeSubdomains; preload',
            'Referrer-Policy': 'same-origin',
            'X-XSS-Protection': '1; mode=block',
            'X-Frame-Options': 'DENY',
            'X-Content-Type-Options': 'nosniff',
        },
        logger: new Logger(40),
    };
    shared.getConfig.mockImplementation(() => {
        return config;
    });
});

afterEach(() => {
    jest.resetAllMocks();
});

describe('lambda-edge', () => {
    // even structure copied from here
    // https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/lambda-event-structure.html#lambda-event-structure-response
    const originResponse: CloudFrontResponseEvent = {
        Records: [
            {
                cf: {
                    config: {
                        distributionDomainName: 'd111111abcdef8.cloudfront.net',
                        distributionId: 'EDFDVBD6EXAMPLE',
                        eventType: 'origin-response',
                        requestId: '4TyzHTaYWb1GX1qTfsHhEqV6HUDd_BzoBZnwfnvQc_1oF26ClkoUSEQ==',
                    },
                    request: {
                        clientIp: '203.0.113.178',
                        headers: {
                            'x-forwarded-for': [
                                {
                                    key: 'X-Forwarded-For',
                                    value: '203.0.113.178',
                                },
                            ],
                            'user-agent': [
                                {
                                    key: 'User-Agent',
                                    value: 'Amazon CloudFront',
                                },
                            ],
                            via: [
                                {
                                    key: 'Via',
                                    value: '2.0 8f22423015641505b8c857a37450d6c0.cloudfront.net (CloudFront)',
                                },
                            ],
                            host: [
                                {
                                    key: 'Host',
                                    value: 'example.org',
                                },
                            ],
                            'cache-control': [
                                {
                                    key: 'Cache-Control',
                                    value: 'no-cache, cf-no-cache',
                                },
                            ],
                        },
                        method: 'GET',
                        origin: {
                            custom: {
                                customHeaders: {},
                                domainName: 'example.org',
                                keepaliveTimeout: 5,
                                path: '',
                                port: 443,
                                protocol: 'https',
                                readTimeout: 30,
                                sslProtocols: ['TLSv1', 'TLSv1.1', 'TLSv1.2'],
                            },
                        },
                        querystring: '',
                        uri: '/',
                    },
                    response: {
                        headers: {
                            'access-control-allow-credentials': [
                                {
                                    key: 'Access-Control-Allow-Credentials',
                                    value: 'true',
                                },
                            ],
                            'access-control-allow-origin': [
                                {
                                    key: 'Access-Control-Allow-Origin',
                                    value: '*',
                                },
                            ],
                            date: [
                                {
                                    key: 'Date',
                                    value: 'Mon, 13 Jan 2020 20:12:38 GMT',
                                },
                            ],
                            'referrer-policy': [
                                {
                                    key: 'Referrer-Policy',
                                    value: 'no-referrer-when-downgrade',
                                },
                            ],
                            server: [
                                {
                                    key: 'Server',
                                    value: 'ExampleCustomOriginServer',
                                },
                            ],
                            'x-content-type-options': [
                                {
                                    key: 'X-Content-Type-Options',
                                    value: 'nosniff',
                                },
                            ],
                            'x-frame-options': [
                                {
                                    key: 'X-Frame-Options',
                                    value: 'DENY',
                                },
                            ],
                            'x-xss-protection': [
                                {
                                    key: 'X-XSS-Protection',
                                    value: '1; mode=block',
                                },
                            ],
                            'content-type': [
                                {
                                    key: 'Content-Type',
                                    value: 'text/html; charset=utf-8',
                                },
                            ],
                            'content-length': [
                                {
                                    key: 'Content-Length',
                                    value: '9593',
                                },
                            ],
                        },
                        status: '200',
                        statusDescription: 'OK',
                    },
                },
            },
        ],
    };

    it('http-headers requests', async () => {
        const result = await httpHeaders.handler(originResponse, Object(), function (_err, data) {
            return data;
        });
        const response = JSON.parse(JSON.stringify(result));
        expect(response.status).toBe('200');
    });
});

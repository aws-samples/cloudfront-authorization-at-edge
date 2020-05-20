// Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { parse as parseQueryString, stringify as stringifyQueryString } from 'querystring';
import { CloudFrontRequestHandler, CloudFrontRequest } from 'aws-lambda';
import { getConfig, extractAndParseCookies, generateCookieHeaders, httpPostWithRetry, createErrorHtml, urlSafe, RequiresConfirmationError } from '../shared/shared';

const { logger, ...CONFIG } = getConfig();
const COGNITO_TOKEN_ENDPOINT = `https://${CONFIG.cognitoAuthDomain}/oauth2/token`;

export const handler: CloudFrontRequestHandler = async (event) => {
    logger.debug(event);
    const request = event.Records[0].cf.request;
    const domainName = request.headers['host'][0].value;
    let redirectedFromUri = `https://${domainName}`;

    try {
        const { code, pkce, requestedUri } = validateQueryStringAndCookies(request);
        logger.debug('Query string and cookies are valid');
        redirectedFromUri += requestedUri;

        const body = stringifyQueryString({
            grant_type: 'authorization_code',
            client_id: CONFIG.clientId,
            redirect_uri: `https://${domainName}${CONFIG.redirectPathSignIn}`,
            code,
            code_verifier: pkce
        });

        const requestConfig: Parameters<typeof httpPostWithRetry>[2] = {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        };
        if (CONFIG.clientSecret) {
            const encodedSecret = Buffer.from(`${CONFIG.clientId}:${CONFIG.clientSecret}`).toString('base64');
            requestConfig.headers.Authorization = `Basic ${encodedSecret}`;
        }
        logger.debug('HTTP POST to Cognito token endpoint:\n', {
            uri: COGNITO_TOKEN_ENDPOINT, body, requestConfig
        });
        const { status, headers, data: tokens } = await httpPostWithRetry(COGNITO_TOKEN_ENDPOINT, body, requestConfig, logger);
        logger.info('Successfully exchanged authorization code for tokens');
        logger.debug('Response from Cognito token endpoint:\n', { status, headers, tokens });

        const response = {
            status: '307',
            statusDescription: 'Temporary Redirect',
            headers: {
                'location': [{
                    key: 'location',
                    value: redirectedFromUri,
                }],
                'set-cookie': generateCookieHeaders.newTokens({
                    tokens, domainName, ...CONFIG
                }),
                ...CONFIG.cloudFrontHeaders,
            }
        };

        logger.debug('Returning response:\n', response);
        return response;
    } catch (err) {
        logger.error(err, err.stack);
        let htmlParams: Parameters<typeof createErrorHtml>[0];
        if (err instanceof RequiresConfirmationError) {
            htmlParams = {
                title: 'Confirm sign-in',
                messageStart: 'To keep you safe, we need your confirmation to sign you in',
                expandText: '(reason)',
                details: err.toString(),
                linkUri: redirectedFromUri,
                linkText: 'Confirm sign-in',
            }
        } else {
            htmlParams = {
                title: 'Sign-in issue',
                messageStart: 'We can\'t sign you in because of a',
                expandText: 'technical problem',
                details: err.toString(),
                linkUri: redirectedFromUri,
                linkText: 'Try again',
            }
        }
        return {
            body: createErrorHtml(htmlParams),
            status: '200',
            headers: {
                ...CONFIG.cloudFrontHeaders,
                'content-type': [{
                    key: 'Content-Type',
                    value: 'text/html; charset=UTF-8',
                }]
            }
        };
    }
}

function validateQueryStringAndCookies(request: CloudFrontRequest) {
    const { code, state, error: cognitoError, error_description } = parseQueryString(request.querystring);
    if (cognitoError) {
        throw new Error(`[Cognito] ${cognitoError}: ${error_description}`);
    }
    if (!code || !state || typeof code !== 'string' || typeof state !== 'string') {
        throw new Error(
            ['Invalid query string. Your query string does not include parameters "state" and "code".',
                'This can happen if your authentication attempt did not originate from this site - this is not allowed'].join(' ')
        );
    }
    let parsedState: { nonce?: string, requestedUri?: string };
    try {
        parsedState = JSON.parse(Buffer.from(urlSafe.parse(state), 'base64').toString());
    } catch {
        throw new Error('Invalid query string. Your query string does not include a valid "state" parameter');
    }
    if (!parsedState.requestedUri || !parsedState.nonce) {
        throw new Error('Invalid query string. Your query string does not include a valid "state" parameter');
    }
    const { nonce: originalNonce, pkce } = extractAndParseCookies(request.headers, CONFIG.clientId);
    if (!parsedState.nonce || !originalNonce || parsedState.nonce !== originalNonce) {
        if (!originalNonce) {
            throw new RequiresConfirmationError('Your browser didn\'t send the nonce cookie along, but it is required for security (prevent CSRF).');
        }
        throw new RequiresConfirmationError('Nonce mismatch. This can happen if you start multiple authentication attempts in parallel (e.g. in separate tabs)');
    }
    return { code, pkce, requestedUri: parsedState.requestedUri || '' };
}

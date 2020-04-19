// Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { CloudFrontHeaders } from 'aws-lambda';
import { readFileSync } from 'fs';
import { parse } from 'cookie';
import axios, { AxiosRequestConfig, AxiosResponse } from 'axios';
import { Agent } from 'https';

export interface CookieSettings {
    idToken: string;
    accessToken: string;
    refreshToken: string;
    nonce: string;
}

export const DEFAULT_COOKIE_SETTINGS: { [key: string]: CookieSettings } = {
    spaMode: {
        idToken: "Path=/; Secure; SameSite=Lax",
        accessToken: "Path=/; Secure; SameSite=Lax",
        refreshToken: "Path=/; Secure; SameSite=Lax",
        nonce: "Path=/; Secure; HttpOnly; Max-Age=1800; SameSite=Lax"
    },
    staticSiteMode: {
        idToken: "Path=/; Secure; HttpOnly; SameSite=Lax",
        accessToken: "Path=/; Secure; HttpOnly; SameSite=Lax",
        refreshToken: "Path=/; Secure; HttpOnly; SameSite=Lax",
        nonce: "Path=/; Secure; HttpOnly; Max-Age=1800; SameSite=Lax"
    },
}

export interface HttpHeaders {
    [key: string]: string;
}

type Mode = 'spaMode' | 'staticSiteMode';

interface ConfigFromDisk {
    userPoolId: string;
    clientId: string;
    oauthScopes: string[];
    cognitoAuthDomain: string;
    redirectPathSignIn: string;
    redirectPathSignOut: string;
    redirectPathAuthRefresh: string;
    cookieSettings: CookieSettings;
    mode: Mode,
    httpHeaders: HttpHeaders;
    clientSecret: string;
}


export interface Config extends ConfigFromDisk {
    tokenIssuer: string;
    tokenJwksUri: string;
    cloudFrontHeaders: CloudFrontHeaders;
}


export function getConfig(): Config {

    const config = JSON.parse(readFileSync(`${__dirname}/configuration.json`).toString('utf8')) as ConfigFromDisk;

    // Derive the issuer and JWKS uri all JWT's will be signed with from the User Pool's ID and region:
    const userPoolRegion = config.userPoolId.match(/^(\S+?)_\S+$/)![1];
    const tokenIssuer = `https://cognito-idp.${userPoolRegion}.amazonaws.com/${config.userPoolId}`;
    const tokenJwksUri = `${tokenIssuer}/.well-known/jwks.json`;

    return {
        ...config, tokenIssuer, tokenJwksUri, cloudFrontHeaders: asCloudFrontHeaders(config.httpHeaders)
    };
}

type Cookies = { [key: string]: string };

function extractCookiesFromHeaders(headers: CloudFrontHeaders) {
    // Cookies are present in the HTTP header "Cookie" that may be present multiple times.
    // This utility function parses occurrences  of that header and splits out all the cookies and their values
    // A simple object is returned that allows easy access by cookie name: e.g. cookies["nonce"]
    if (!headers['cookie']) {
        return {};
    }
    const cookies = headers['cookie'].reduce((reduced, header) => Object.assign(reduced, parse(header.value)), {} as Cookies);

    return cookies;
}

function withCookieDomain(distributionDomainName: string, cookieSettings: string) {
    if (cookieSettings.toLowerCase().indexOf('domain') === -1) {
        // Add leading dot for compatibility with Amplify (or js-cookie really)
        return `${cookieSettings}; Domain=.${distributionDomainName}`;
    }
    return cookieSettings;
}

export function asCloudFrontHeaders(headers: HttpHeaders): CloudFrontHeaders {
    return Object.entries(headers).reduce((reduced, [key, value]) => (
        Object.assign(reduced, {
            [key.toLowerCase()]: [{
                key,
                value
            }]
        })
    ), {} as CloudFrontHeaders);
}

export function extractAndParseCookies(headers: CloudFrontHeaders, clientId: string) {
    const cookies = extractCookiesFromHeaders(headers);
    if (!cookies) {
        return {};
    }

    const keyPrefix = `CognitoIdentityServiceProvider.${clientId}`;
    const lastUserKey = `${keyPrefix}.LastAuthUser`;
    const tokenUserName = cookies[lastUserKey];

    const scopeKey = `${keyPrefix}.${tokenUserName}.tokenScopesString`;
    const scopes = cookies[scopeKey];

    const idTokenKey = `${keyPrefix}.${tokenUserName}.idToken`;
    const idToken = cookies[idTokenKey];

    const accessTokenKey = `${keyPrefix}.${tokenUserName}.accessToken`;
    const accessToken = cookies[accessTokenKey];

    const refreshTokenKey = `${keyPrefix}.${tokenUserName}.refreshToken`;
    const refreshToken = cookies[refreshTokenKey];

    return {
        tokenUserName,
        idToken,
        accessToken,
        refreshToken,
        scopes,
        nonce: cookies['spa-auth-edge-nonce'],
        pkce: cookies['spa-auth-edge-pkce'],
    }
}

export function decodeToken(jwt: string) {
    const tokenBody = jwt.split('.')[1];
    const decodableTokenBody = tokenBody.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(decodableTokenBody, 'base64').toString());
}

export function getCookieHeaders(param: {
    clientId: string,
    oauthScopes: string[],
    tokens: { id_token: string, access_token: string, refresh_token?: string },
    domainName: string,
    explicitCookieSettings: CookieSettings,
    mode: Mode,
    expireAllTokens?: boolean,
}
) {
    // Set cookies with the exact names and values Amplify uses for seamless interoperability with Amplify
    const decodedIdToken = decodeToken(param.tokens.id_token);
    const tokenUserName = decodedIdToken['cognito:username'];
    const keyPrefix = `CognitoIdentityServiceProvider.${param.clientId}`;
    const idTokenKey = `${keyPrefix}.${tokenUserName}.idToken`;
    const accessTokenKey = `${keyPrefix}.${tokenUserName}.accessToken`;
    const refreshTokenKey = `${keyPrefix}.${tokenUserName}.refreshToken`;
    const lastUserKey = `${keyPrefix}.LastAuthUser`;
    const scopeKey = `${keyPrefix}.${tokenUserName}.tokenScopesString`;
    const scopesString = param.oauthScopes.join(' ');
    const userDataKey = `${keyPrefix}.${tokenUserName}.userData`;
    const userData = JSON.stringify({
        UserAttributes: [
            {
                Name: 'sub',
                Value: decodedIdToken['sub']
            },
            {
                Name: 'email',
                Value: decodedIdToken['email']
            }
        ],
        Username: tokenUserName
    });

    const cookieSettings = Object.fromEntries(
        Object.entries(param.explicitCookieSettings).map(([k, v]) => [k, v || DEFAULT_COOKIE_SETTINGS[param.mode][k as keyof CookieSettings]])
    ) as CookieSettings;

    const cookies = {
        [idTokenKey]: `${param.tokens.id_token}; ${withCookieDomain(param.domainName, cookieSettings.idToken)}`,
        [accessTokenKey]: `${param.tokens.access_token}; ${withCookieDomain(param.domainName, cookieSettings.accessToken)}`,
        [refreshTokenKey]: `${param.tokens.refresh_token}; ${withCookieDomain(param.domainName, cookieSettings.refreshToken)}`,
        [lastUserKey]: `${tokenUserName}; ${withCookieDomain(param.domainName, cookieSettings.idToken)}`,
        [scopeKey]: `${scopesString}; ${withCookieDomain(param.domainName, cookieSettings.accessToken)}`,
        [userDataKey]: `${encodeURIComponent(userData)}; ${withCookieDomain(param.domainName, cookieSettings.idToken)}`,
        'amplify-signin-with-hostedUI': `true; ${withCookieDomain(param.domainName, cookieSettings.accessToken)}`,
    };

    // Expire cookies if needed
    if (param.expireAllTokens) {
        Object.keys(cookies).forEach(key => cookies[key] = expireCookie(cookies[key]));
    } else if (!param.tokens.refresh_token) {
        cookies[refreshTokenKey] = expireCookie(cookies[refreshTokenKey]);
    }

    // Return object in format of CloudFront headers
    return Object.entries(cookies).map(([k, v]) => ({ key: 'set-cookie', value: `${k}=${v}` }));
}

function expireCookie(cookie: string) {
    const cookieParts = cookie
        .split(';')
        .map(part => part.trim())
        .filter(part => !part.toLowerCase().startsWith('max-age'))
        .filter(part => !part.toLowerCase().startsWith('expires'));
    const expires = `Expires=${new Date(0).toUTCString()}`;
    const [, ...settings] = cookieParts; // first part is the cookie value, which we'll clear
    return ['', ...settings, expires].join('; ');
}

const AXIOS_INSTANCE = axios.create({
    httpsAgent: new Agent({ keepAlive: true }),
});


export async function httpPostWithRetry(url: string, data: any, config: AxiosRequestConfig): Promise<AxiosResponse<any>> {
    let attempts = 0;
    while (++attempts) {
        try {
            return await AXIOS_INSTANCE.post(url, data, config);
        } catch (err) {
            console.error(`HTTP POST to ${url} failed (attempt ${attempts}):`);
            console.error(err.response && err.response.data || err);
            if (attempts >= 5) {
                // Try 5 times at most
                break;
            }
            if (attempts >= 2) {
                // After attempting twice immediately, do some exponential backoff with jitter
                await new Promise(resolve => setTimeout(resolve, 25 * (Math.pow(2, attempts) + Math.random() * attempts)));
            }
        }
    }
    throw new Error(`HTTP POST to ${url} failed`);
}

export function createErrorHtml(title: string, message: string, tryAgainHref: string) {
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

export const urlSafe = {
    /*
        Functions to translate base64-encoded strings, so they can be used:
        - in URL's without needing additional encoding
        - in OAuth2 PKCE verifier

        stringify:
            use this on a base64-encoded string to translate = + / into replacement characters

        parse:
            use this on a string that was previously urlSafe.stringify'ed to return it to
            its prior pure-base64 form. Note that trailing = are not added, but NodeJS does not care
    */
    stringify: (b64encodedString: string) => b64encodedString.replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_'),
    parse: (b64encodedString: string) => b64encodedString.replace(/-/g, '+').replace(/_/g, '/'),
}

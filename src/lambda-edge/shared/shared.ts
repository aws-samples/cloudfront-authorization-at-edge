// Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { CloudFrontHeaders } from "aws-lambda";
import { readFileSync } from "fs";
import { createHmac } from "crypto";
import { parse } from "cookie";
import axios, { AxiosRequestConfig, AxiosResponse } from "axios";
import { Agent } from "https";
import html from "./error-page/template.html";
import { validate } from "./validate-jwt";

export interface CookieSettings {
  idToken: string;
  accessToken: string;
  refreshToken: string;
  nonce: string;
  [key: string]: string;
}

function getDefaultCookieSettings(props: {
  mode: "spaMode" | "staticSiteMode";
  compatibility: "amplify" | "elasticsearch";
}): CookieSettings {
  // Defaults can be overridden by the user (CloudFormation Stack parameter) but should be solid enough for most purposes
  if (props.compatibility === "amplify") {
    if (props.mode === "spaMode") {
      return {
        idToken: "Path=/; Secure; SameSite=Lax",
        accessToken: "Path=/; Secure; SameSite=Lax",
        refreshToken: "Path=/; Secure; SameSite=Lax",
        nonce: "Path=/; Secure; HttpOnly; SameSite=Lax",
      };
    } else if (props.mode === "staticSiteMode") {
      return {
        idToken: "Path=/; Secure; HttpOnly; SameSite=Lax",
        accessToken: "Path=/; Secure; HttpOnly; SameSite=Lax",
        refreshToken: "Path=/; Secure; HttpOnly; SameSite=Lax",
        nonce: "Path=/; Secure; HttpOnly; SameSite=Lax",
      };
    }
  } else if (props.compatibility === "elasticsearch") {
    return {
      idToken: "Path=/; Secure; HttpOnly; SameSite=Lax",
      accessToken: "Path=/; Secure; HttpOnly; SameSite=Lax",
      refreshToken: "Path=/; Secure; HttpOnly; SameSite=Lax",
      nonce: "Path=/; Secure; HttpOnly; SameSite=Lax",
      cognitoEnabled: "Path=/; Secure; SameSite=Lax",
    };
  }
  throw new Error(
    `Cannot determine default cookiesettings for ${props.mode} with compatibility ${props.compatibility}`
  );
}

export interface HttpHeaders {
  [key: string]: string;
}

type Mode = "spaMode" | "staticSiteMode";

interface ConfigFromDisk {
  httpHeaders: HttpHeaders;
  logLevel: keyof typeof LogLevel;
}

interface CompleteConfigFromDisk extends ConfigFromDisk {
  userPoolArn: string;
  clientId: string;
  oauthScopes: string[];
  cognitoAuthDomain: string;
  redirectPathSignIn: string;
  redirectPathSignOut: string;
  redirectPathAuthRefresh: string;
  cookieSettings: CookieSettings;
  mode: Mode;
  clientSecret: string;
  nonceSigningSecret: string;
  cookieCompatibility: "amplify" | "elasticsearch";
  additionalCookies: { [name: string]: string };
  requiredGroup: string;
  secretAllowedCharacters?: string;
  pkceLength?: number;
  nonceLength?: number;
  nonceMaxAge?: number;
}

function isCompleteConfig(config: any): config is CompleteConfigFromDisk {
  return config["userPoolArn"] !== undefined;
}

enum LogLevel {
  "none" = 0,
  "error" = 10,
  "warn" = 20,
  "info" = 30,
  "debug" = 40,
}

class Logger {
  constructor(private logLevel: LogLevel) {}

  private jsonify(args: any[]) {
    return args.map((arg: any) => {
      if (typeof arg === "object") {
        try {
          return JSON.stringify(arg);
        } catch {
          return arg;
        }
      }
      return arg;
    });
  }
  public info(...args: any) {
    if (this.logLevel >= LogLevel.info) {
      console.log(...this.jsonify(args));
    }
  }
  public warn(...args: any) {
    if (this.logLevel >= LogLevel.warn) {
      console.warn(...this.jsonify(args));
    }
  }
  public error(...args: any) {
    if (this.logLevel >= LogLevel.error) {
      console.error(...this.jsonify(args));
    }
  }
  public debug(...args: any) {
    if (this.logLevel >= LogLevel.debug) {
      console.trace(...this.jsonify(args));
    }
  }
}

export interface Config extends ConfigFromDisk {
  cloudFrontHeaders: CloudFrontHeaders;
  logger: Logger;
}

export interface CompleteConfig extends Config, CompleteConfigFromDisk {
  tokenIssuer: string;
  tokenJwksUri: string;
  cloudFrontHeaders: CloudFrontHeaders;
  secretAllowedCharacters: string;
  pkceLength: number;
  nonceLength: number;
  nonceMaxAge: number;
}

export function getConfig(): Config {
  const config = JSON.parse(
    readFileSync(`${__dirname}/configuration.json`).toString("utf8")
  ) as ConfigFromDisk;
  return {
    cloudFrontHeaders: asCloudFrontHeaders(config.httpHeaders),
    logger: new Logger(LogLevel[config.logLevel]),
    ...config,
  };
}

export function getCompleteConfig(): CompleteConfig {
  const config = getConfig();

  if (!isCompleteConfig(config)) {
    throw new Error("Incomplete config in configuration.json");
  }

  // Derive the issuer and JWKS uri all JWT's will be signed with from the User Pool's ID and region:
  const userPoolId = config.userPoolArn.split("/")[1];
  const userPoolRegion = userPoolId.match(/^(\S+?)_\S+$/)![1];
  const tokenIssuer = `https://cognito-idp.${userPoolRegion}.amazonaws.com/${userPoolId}`;
  const tokenJwksUri = `${tokenIssuer}/.well-known/jwks.json`;

  // Derive cookie settings by merging the defaults with the explicitly provided values
  const defaultCookieSettings = getDefaultCookieSettings({
    compatibility: config.cookieCompatibility,
    mode: config.mode,
  });
  const cookieSettings = config.cookieSettings
    ? (Object.fromEntries(
        Object.entries({
          ...defaultCookieSettings,
          ...config.cookieSettings,
        }).map(([k, v]) => [
          k,
          v || defaultCookieSettings[k as keyof CookieSettings],
        ])
      ) as CookieSettings)
    : defaultCookieSettings;

  // Defaults for nonce and PKCE
  const defaults = {
    secretAllowedCharacters:
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~",
    pkceLength: 43, // Should be between 43 and 128 - per spec
    nonceLength: 16,
    nonceMaxAge:
      (cookieSettings?.nonce &&
        parseInt(parse(cookieSettings.nonce.toLowerCase())["max-age"])) ||
      60 * 60 * 24,
  };

  return {
    ...defaults,
    ...config,
    cookieSettings,
    tokenIssuer,
    tokenJwksUri,
  };
}

type Cookies = { [key: string]: string };

function extractCookiesFromHeaders(headers: CloudFrontHeaders) {
  // Cookies are present in the HTTP header "Cookie" that may be present multiple times.
  // This utility function parses occurrences  of that header and splits out all the cookies and their values
  // A simple object is returned that allows easy access by cookie name: e.g. cookies["nonce"]
  if (!headers["cookie"]) {
    return {};
  }
  const cookies = headers["cookie"].reduce(
    (reduced, header) => Object.assign(reduced, parse(header.value)),
    {} as Cookies
  );

  return cookies;
}

function withCookieDomain(
  distributionDomainName: string,
  cookieSettings: string
) {
  // Add the domain to the cookiesetting
  if (cookieSettings.toLowerCase().indexOf("domain") === -1) {
    // Add leading dot for compatibility with Amplify (or js-cookie really)
    return `${cookieSettings}; Domain=.${distributionDomainName}`;
  }
  return cookieSettings;
}

export function asCloudFrontHeaders(headers: HttpHeaders): CloudFrontHeaders {
  // Turn a regular key-value object into the explicit format expected by CloudFront
  return Object.entries(headers).reduce(
    (reduced, [key, value]) =>
      Object.assign(reduced, {
        [key.toLowerCase()]: [
          {
            key,
            value,
          },
        ],
      }),
    {} as CloudFrontHeaders
  );
}

export function getAmplifyCookieNames(
  clientId: string,
  cookiesOrUserName: Cookies | string
) {
  const keyPrefix = `CognitoIdentityServiceProvider.${clientId}`;
  const lastUserKey = `${keyPrefix}.LastAuthUser`;
  let tokenUserName: string;
  if (typeof cookiesOrUserName === "string") {
    tokenUserName = cookiesOrUserName;
  } else {
    tokenUserName = cookiesOrUserName[lastUserKey];
  }
  return {
    lastUserKey,
    userDataKey: `${keyPrefix}.${tokenUserName}.userData`,
    scopeKey: `${keyPrefix}.${tokenUserName}.tokenScopesString`,
    idTokenKey: `${keyPrefix}.${tokenUserName}.idToken`,
    accessTokenKey: `${keyPrefix}.${tokenUserName}.accessToken`,
    refreshTokenKey: `${keyPrefix}.${tokenUserName}.refreshToken`,
  };
}

export function getElasticsearchCookieNames() {
  return {
    idTokenKey: "ID-TOKEN",
    accessTokenKey: "ACCESS-TOKEN",
    refreshTokenKey: "REFRESH-TOKEN",
    cognitoEnabledKey: "COGNITO-ENABLED",
  };
}

export function extractAndParseCookies(
  headers: CloudFrontHeaders,
  clientId: string,
  cookieCompatibility: "amplify" | "elasticsearch"
) {
  const cookies = extractCookiesFromHeaders(headers);
  if (!cookies) {
    return {};
  }

  let cookieNames: { [name: string]: string };
  if (cookieCompatibility === "amplify") {
    cookieNames = getAmplifyCookieNames(clientId, cookies);
  } else {
    cookieNames = getElasticsearchCookieNames();
  }

  return {
    tokenUserName: cookies[cookieNames.lastUserKey],
    idToken: cookies[cookieNames.idTokenKey],
    accessToken: cookies[cookieNames.accessTokenKey],
    refreshToken: cookies[cookieNames.refreshTokenKey],
    scopes: cookies[cookieNames.scopeKey],
    nonce: cookies["spa-auth-edge-nonce"],
    nonceHmac: cookies["spa-auth-edge-nonce-hmac"],
    pkce: cookies["spa-auth-edge-pkce"],
  };
}

interface GenerateCookieHeadersParam {
  clientId: string;
  oauthScopes: string[];
  domainName: string;
  cookieSettings: CookieSettings;
  mode: Mode;
  cookieCompatibility: "amplify" | "elasticsearch";
  additionalCookies: { [name: string]: string };
  tokens: {
    id_token: string;
    access_token: string;
    refresh_token: string;
  };
}

export const generateCookieHeaders = {
  newTokens: (param: GenerateCookieHeadersParam) =>
    _generateCookieHeaders({ ...param, event: "newTokens" }),
  signOut: (param: GenerateCookieHeadersParam) =>
    _generateCookieHeaders({ ...param, event: "signOut" }),
  refreshFailed: (param: GenerateCookieHeadersParam) =>
    _generateCookieHeaders({ ...param, event: "refreshFailed" }),
};

function _generateCookieHeaders(
  param: GenerateCookieHeadersParam & {
    event: "newTokens" | "signOut" | "refreshFailed";
  }
) {
  /*
    Generate cookie headers for the following scenario's:
      - new tokens: called from Parse Auth and Refresh Auth lambda, when receiving fresh JWT's from Cognito
      - sign out: called from Sign Out Lambda, when the user visits the sign out URL
      - refresh failed: called from Refresh Auth lambda when the refresh failed (e.g. because the refresh token has expired)

    Note that there are other places besides this helper function where cookies can be set (search codebase for "set-cookie")
    */

  const decodedIdToken = decodeToken(param.tokens.id_token);
  const tokenUserName = decodedIdToken["cognito:username"];

  let cookies: Cookies;
  let cookieNames: { [name: string]: string };
  if (param.cookieCompatibility === "amplify") {
    cookieNames = getAmplifyCookieNames(param.clientId, tokenUserName);
    const userData = JSON.stringify({
      UserAttributes: [
        {
          Name: "sub",
          Value: decodedIdToken["sub"],
        },
        {
          Name: "email",
          Value: decodedIdToken["email"],
        },
      ],
      Username: tokenUserName,
    });

    // Construct object with the cookies
    cookies = {
      [cookieNames.lastUserKey]: `${tokenUserName}; ${withCookieDomain(
        param.domainName,
        param.cookieSettings.idToken
      )}`,
      [cookieNames.scopeKey]: `${param.oauthScopes.join(
        " "
      )}; ${withCookieDomain(
        param.domainName,
        param.cookieSettings.accessToken
      )}`,
      [cookieNames.userDataKey]: `${encodeURIComponent(
        userData
      )}; ${withCookieDomain(param.domainName, param.cookieSettings.idToken)}`,
      "amplify-signin-with-hostedUI": `true; ${withCookieDomain(
        param.domainName,
        param.cookieSettings.accessToken
      )}`,
    };
  } else {
    cookieNames = getElasticsearchCookieNames();
    cookies = {
      [cookieNames.cognitoEnabledKey]: `True; ${withCookieDomain(
        param.domainName,
        param.cookieSettings.cognitoEnabled
      )}`,
    };
  }
  Object.assign(cookies, {
    [cookieNames.idTokenKey]: `${param.tokens.id_token}; ${withCookieDomain(
      param.domainName,
      param.cookieSettings.idToken
    )}`,
    [cookieNames.accessTokenKey]: `${
      param.tokens.access_token
    }; ${withCookieDomain(param.domainName, param.cookieSettings.accessToken)}`,
    [cookieNames.refreshTokenKey]: `${
      param.tokens.refresh_token
    }; ${withCookieDomain(
      param.domainName,
      param.cookieSettings.refreshToken
    )}`,
  });

  if (param.event === "signOut") {
    // Expire all cookies
    Object.keys(cookies).forEach(
      (key) => (cookies[key] = expireCookie(cookies[key]))
    );
  } else if (param.event === "refreshFailed") {
    // Expire refresh token (so the browser will not send it in vain again)
    cookies[cookieNames.refreshTokenKey] = expireCookie(
      cookies[cookieNames.refreshTokenKey]
    );
  }

  // Always expire nonce, nonceHmac and pkce - this is valid in all scenario's:
  // * event === 'newTokens' --> you just signed in and used your nonce and pkce successfully, don't need them no more
  // * event === 'refreshFailed' --> you are signed in already, why do you still have a nonce?
  // * event === 'signOut' --> clear ALL cookies anyway
  [
    "spa-auth-edge-nonce",
    "spa-auth-edge-nonce-hmac",
    "spa-auth-edge-pkce",
  ].forEach((key) => {
    cookies[key] = expireCookie();
  });

  // Return cookie object in format of CloudFront headers
  return Object.entries({
    ...param.additionalCookies,
    ...cookies,
  }).map(([k, v]) => ({ key: "set-cookie", value: `${k}=${v}` }));
}

function expireCookie(cookie: string = "") {
  const cookieParts = cookie
    .split(";")
    .map((part) => part.trim())
    .filter((part) => !part.toLowerCase().startsWith("max-age"))
    .filter((part) => !part.toLowerCase().startsWith("expires"));
  const expires = `Expires=${new Date(0).toUTCString()}`;
  const [, ...settings] = cookieParts; // first part is the cookie value, which we'll clear
  return ["", ...settings, expires].join("; ");
}

const AXIOS_INSTANCE = axios.create({
  httpsAgent: new Agent({ keepAlive: true }),
});

export function decodeToken(jwt: string) {
  const tokenBody = jwt.split(".")[1];
  const decodableTokenBody = tokenBody.replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(Buffer.from(decodableTokenBody, "base64").toString());
}

export async function httpPostWithRetry(
  url: string,
  data: any,
  config: AxiosRequestConfig,
  logger: Logger
): Promise<AxiosResponse<any>> {
  let attempts = 0;
  while (true) {
    ++attempts;
    try {
      return await AXIOS_INSTANCE.post(url, data, config);
    } catch (err) {
      logger.debug(`HTTP POST to ${url} failed (attempt ${attempts}):`);
      logger.debug((err.response && err.response.data) || err);
      if (attempts >= 5) {
        // Try 5 times at most
        logger.error(
          `No success after ${attempts} attempts, seizing further attempts`
        );
        throw err;
      }
      if (attempts >= 2) {
        // After attempting twice immediately, do some exponential backoff with jitter
        logger.debug(
          "Doing exponential backoff with jitter, before attempting HTTP POST again ..."
        );
        await new Promise((resolve) =>
          setTimeout(
            resolve,
            25 * (Math.pow(2, attempts) + Math.random() * attempts)
          )
        );
        logger.debug("Done waiting, will try HTTP POST again now");
      }
    }
  }
}

export function createErrorHtml(props: {
  title: string;
  message: string;
  expandText?: string;
  details?: string;
  linkUri: string;
  linkText: string;
}) {
  const params = { ...props, region: process.env.AWS_REGION };
  return html.replace(
    /\${([^}]*)}/g,
    (_, v: keyof typeof params) => params[v] || ""
  );
}

export const urlSafe = {
  /*
        Functions to translate base64-encoded strings, so they can be used:
        - in URL's without needing additional encoding
        - in OAuth2 PKCE verifier
        - in cookies (to be on the safe side, as = + / are in fact valid characters in cookies)

        stringify:
            use this on a base64-encoded string to translate = + / into replacement characters

        parse:
            use this on a string that was previously urlSafe.stringify'ed to return it to
            its prior pure-base64 form. Note that trailing = are not added, but NodeJS does not care
    */
  stringify: (b64encodedString: string) =>
    b64encodedString.replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_"),
  parse: (b64encodedString: string) =>
    b64encodedString.replace(/-/g, "+").replace(/_/g, "/"),
};

export function sign(
  stringToSign: string,
  secret: string,
  signatureLength: number
) {
  const digest = createHmac("sha256", secret)
    .update(stringToSign)
    .digest("base64")
    .slice(0, signatureLength);
  const signature = urlSafe.stringify(digest);
  return signature;
}

export function timestampInSeconds() {
  return (Date.now() / 1000) | 0;
}

export async function validateAndCheckIdToken(
  idToken: string,
  config: CompleteConfig
) {
  config.logger.info("Validating JWT ...");
  let idTokenPayload = await validate(
    idToken,
    config.tokenJwksUri,
    config.tokenIssuer,
    config.clientId
  );
  config.logger.info("JWT is valid");

  // Check that the ID token has the required group.
  if (config.requiredGroup) {
    let cognitoGroups = idTokenPayload["cognito:groups"];
    if (!cognitoGroups) {
      throw new MissingRequiredGroupError("Token does not have any groups");
    }

    if (!cognitoGroups.includes(config.requiredGroup)) {
      throw new MissingRequiredGroupError("Token does not have required group");
    }
    config.logger.info("JWT has requiredGroup");
  }
}

export class MissingRequiredGroupError extends Error {}

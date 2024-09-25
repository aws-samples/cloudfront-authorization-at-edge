// Copyright 2021 Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { CloudFrontHeaders } from "aws-lambda";
import { readFileSync } from "fs";
import { formatWithOptions } from "util";
import { createHmac, randomInt } from "crypto";
import { parse } from "cookie";
import { fetch } from "./https";
import { Agent, RequestOptions } from "https";
import html from "./error-page/template.html";
import { CognitoJwtVerifier } from "aws-jwt-verify";
import { Jwks } from "aws-jwt-verify/jwk";
export {
  CognitoJwtInvalidGroupError,
  JwtExpiredError,
} from "aws-jwt-verify/error";

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
  redirectPathAuthRefresh: string;
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
        refreshToken: `Path=${props.redirectPathAuthRefresh}; Secure; HttpOnly; SameSite=Lax`,
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
    `Cannot determine default cookie settings for ${props.mode} with compatibility ${props.compatibility}`
  );
}

export interface HttpHeaders {
  [key: string]: string;
}

type Mode = "spaMode" | "staticSiteMode";

interface ConfigFromDisk {
  logLevel: keyof typeof LogLevel;
}

interface ConfigFromDiskWithHeaders extends ConfigFromDisk {
  httpHeaders: HttpHeaders;
}

interface ConfigFromDiskComplete extends ConfigFromDiskWithHeaders {
  userPoolArn: string;
  jwks: Jwks;
  clientId: string;
  oauthScopes: string[];
  cognitoAuthDomain: string;
  redirectPathSignIn: string;
  redirectPathSignOut: string;
  signOutUrl: string;
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

function isConfigWithHeaders(config: any): config is ConfigFromDiskComplete {
  return config["httpHeaders"] !== undefined;
}

function isCompleteConfig(config: any): config is ConfigFromDiskComplete {
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

  private format(args: unknown[], depth = 10) {
    return args.map((arg) => formatWithOptions({ depth }, arg)).join(" ");
  }

  public info(...args: unknown[]) {
    if (this.logLevel >= LogLevel.info) {
      console.log(this.format(args));
    }
  }
  public warn(...args: unknown[]) {
    if (this.logLevel >= LogLevel.warn) {
      console.warn(this.format(args));
    }
  }
  public error(...args: unknown[]) {
    if (this.logLevel >= LogLevel.error) {
      console.error(this.format(args));
    }
  }
  public debug(...args: unknown[]) {
    if (this.logLevel >= LogLevel.debug) {
      console.trace(this.format(args));
    }
  }
}

export interface Config extends ConfigFromDisk {
  logger: Logger;
}

export interface ConfigWithHeaders extends Config, ConfigFromDiskWithHeaders {
  cloudFrontHeaders: CloudFrontHeaders;
}

export interface CompleteConfig
  extends ConfigWithHeaders,
    ConfigFromDiskComplete {
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
    logger: new Logger(LogLevel[config.logLevel]),
    ...config,
  };
}

export function getConfigWithHeaders(): ConfigWithHeaders {
  const config = getConfig();

  if (!isConfigWithHeaders(config)) {
    throw new Error("Incomplete config in configuration.json");
  }

  return {
    cloudFrontHeaders: asCloudFrontHeaders(config.httpHeaders),
    ...config,
  };
}

export function getCompleteConfig(): CompleteConfig {
  const config = getConfigWithHeaders();

  if (!isCompleteConfig(config)) {
    throw new Error("Incomplete config in configuration.json");
  }

  // Derive cookie settings by merging the defaults with the explicitly provided values
  const defaultCookieSettings = getDefaultCookieSettings({
    compatibility: config.cookieCompatibility,
    mode: config.mode,
    redirectPathAuthRefresh: config.redirectPathAuthRefresh,
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
  };
}

export function getConfigWithJwtVerifier() {
  const config = getCompleteConfig();
  const userPoolId = config.userPoolArn.split("/")[1];
  const jwtVerifier = CognitoJwtVerifier.create({
    userPoolId,
    clientId: config.clientId,
    tokenUse: "id",
    groups: config.requiredGroup || undefined,
  });

  // Optimization: load the JWKS (as it was at deploy-time) into the cache.
  // Then, the JWKS does not need to be fetched at runtime,
  // as long as only JWTs come by with a kid that is in this cached JWKS:
  jwtVerifier.cacheJwks(config.jwks);

  return {
    ...config,
    jwtVerifier,
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

export function asCloudFrontHeaders(headers: HttpHeaders): CloudFrontHeaders {
  if (!headers) return {};
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
    hostedUiKey: "amplify-signin-with-hostedUI",
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
    refreshFailed: cookies["spa-auth-edge-refresh"],
  };
}

interface GenerateCookieHeadersParam {
  clientId: string;
  oauthScopes: string[];
  cookieSettings: CookieSettings;
  cookieCompatibility: "amplify" | "elasticsearch";
  additionalCookies: { [name: string]: string };
  tokens: {
    id: string;
    access?: string;
    refresh?: string;
  };
}

export const generateCookieHeaders = {
  signIn: (
    param: GenerateCookieHeadersParam & {
      tokens: { id: string; access: string; refresh: string };
    }
  ) => _generateCookieHeaders({ ...param, scenario: "SIGN_IN" }),
  refresh: (
    param: GenerateCookieHeadersParam & {
      tokens: { id: string; access: string };
    }
  ) => _generateCookieHeaders({ ...param, scenario: "REFRESH" }),
  refreshFailed: (param: GenerateCookieHeadersParam) =>
    _generateCookieHeaders({ ...param, scenario: "REFRESH_FAILED" }),
  signOut: (param: GenerateCookieHeadersParam) =>
    _generateCookieHeaders({ ...param, scenario: "SIGN_OUT" }),
};

function _generateCookieHeaders(
  param: GenerateCookieHeadersParam & {
    scenario: "SIGN_IN" | "SIGN_OUT" | "REFRESH" | "REFRESH_FAILED";
  }
) {
  /**
   * Generate cookie headers to set, or clear, cookies with JWTs.
   *
   * This is centralized in this function because there is logic to determine
   * the right cookie names, that we do not want to repeat everywhere.
   *
   * Note that there are other places besides this helper function where
   * cookies can be set (search codebase for "set-cookie").
   */

  const decodedIdToken = decodeToken(param.tokens.id);
  const tokenUserName = decodedIdToken["cognito:username"];
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

  const cookiesToSetOrExpire: Cookies = {};
  const cookieNames =
    param.cookieCompatibility === "amplify"
      ? getAmplifyCookieNames(param.clientId, tokenUserName)
      : getElasticsearchCookieNames();

  // Set or clear JWTs from the cookies
  if (param.scenario === "SIGN_IN") {
    // JWTs:
    cookiesToSetOrExpire[
      cookieNames.idTokenKey
    ] = `${param.tokens.id}; ${param.cookieSettings.idToken}`;
    cookiesToSetOrExpire[
      cookieNames.accessTokenKey
    ] = `${param.tokens.access}; ${param.cookieSettings.accessToken}`;
    cookiesToSetOrExpire[
      cookieNames.refreshTokenKey
    ] = `${param.tokens.refresh}; ${param.cookieSettings.refreshToken}`;
    // Other cookies:
    if ("lastUserKey" in cookieNames)
      cookiesToSetOrExpire[
        cookieNames.lastUserKey
      ] = `${tokenUserName}; ${param.cookieSettings.idToken}`;
    if ("scopeKey" in cookieNames)
      cookiesToSetOrExpire[cookieNames.scopeKey] = `${param.oauthScopes.join(
        " "
      )}; ${param.cookieSettings.accessToken}`;
    if ("userDataKey" in cookieNames)
      cookiesToSetOrExpire[cookieNames.userDataKey] = `${encodeURIComponent(
        userData
      )}; ${param.cookieSettings.idToken}`;
    if ("hostedUiKey" in cookieNames)
      cookiesToSetOrExpire[
        cookieNames.hostedUiKey
      ] = `true; ${param.cookieSettings.accessToken}`;
    if ("cognitoEnabledKey" in cookieNames)
      cookiesToSetOrExpire[
        cookieNames.cognitoEnabledKey
      ] = `True; ${param.cookieSettings.cognitoEnabled}`;
    // Clear marker for failed refresh
    cookiesToSetOrExpire["spa-auth-edge-refresh"] = addExpiry(
      param.cookieSettings.nonce
    );
  } else if (param.scenario === "REFRESH") {
    cookiesToSetOrExpire[
      cookieNames.idTokenKey
    ] = `${param.tokens.id}; ${param.cookieSettings.idToken}`;
    cookiesToSetOrExpire[
      cookieNames.accessTokenKey
    ] = `${param.tokens.access}; ${param.cookieSettings.accessToken}`;
    // Clear marker for failed refresh
    cookiesToSetOrExpire["spa-auth-edge-refresh"] = addExpiry(
      param.cookieSettings.nonce
    );
  } else if (param.scenario === "SIGN_OUT") {
    // Expire JWTs
    cookiesToSetOrExpire[cookieNames.idTokenKey] = addExpiry(
      param.cookieSettings.idToken
    );
    cookiesToSetOrExpire[cookieNames.accessTokenKey] = addExpiry(
      param.cookieSettings.accessToken
    );
    cookiesToSetOrExpire[cookieNames.refreshTokenKey] = addExpiry(
      param.cookieSettings.refreshToken
    );
    // Expire other cookies
    if ("lastUserKey" in cookieNames)
      cookiesToSetOrExpire[cookieNames.lastUserKey] = addExpiry(
        param.cookieSettings.idToken
      );
    if ("scopeKey" in cookieNames)
      cookiesToSetOrExpire[cookieNames.scopeKey] = addExpiry(
        param.cookieSettings.accessToken
      );
    if ("userDataKey" in cookieNames)
      cookiesToSetOrExpire[cookieNames.userDataKey] = addExpiry(
        param.cookieSettings.idToken
      );
    if ("hostedUiKey" in cookieNames)
      cookiesToSetOrExpire[cookieNames.hostedUiKey] = addExpiry(
        param.cookieSettings.accessToken
      );
    if ("cognitoEnabledKey" in cookieNames)
      cookiesToSetOrExpire[cookieNames.cognitoEnabledKey] = addExpiry(
        param.cookieSettings.cognitoEnabled
      );
    // Clear marker for failed refresh
    cookiesToSetOrExpire["spa-auth-edge-refresh"] = addExpiry(
      param.cookieSettings.nonce
    );
  } else if (param.scenario === "REFRESH_FAILED") {
    // Expire refresh token only
    cookiesToSetOrExpire[cookieNames.refreshTokenKey] = addExpiry(
      param.cookieSettings.refreshToken
    );
    // Add marker for failed refresh
    cookiesToSetOrExpire[
      "spa-auth-edge-refresh"
    ] = `failed; ${param.cookieSettings.nonce}`;
  }

  // Always expire nonce, nonceHmac and pkce
  [
    "spa-auth-edge-nonce",
    "spa-auth-edge-nonce-hmac",
    "spa-auth-edge-pkce",
  ].forEach((key) => {
    cookiesToSetOrExpire[key] = addExpiry(param.cookieSettings.nonce);
  });

  // Return cookie object in format of CloudFront headers
  return Object.entries({
    ...param.additionalCookies,
    ...cookiesToSetOrExpire,
  }).map(([k, v]) => ({ key: "set-cookie", value: `${k}=${v}` }));
}

/**
 * Expire a cookie by setting its expiration time to the epoch start
 * @param cookieSettings The cookie settings to add the expire setting to, for example: "Domain=example.com; Secure; HttpOnly"
 * @returns Updated cookie settings that you can use as cookie value, i.e. with leading ; and expire instruction, for example: "; Domain=example.com; Secure; HttpOnly; Expires=Thu, 01 Jan 1970 00:00:00 GMT"
 */
function addExpiry(cookieSettings: string) {
  const parts = cookieSettings
    .split(";")
    .map((part) => part.trim())
    .filter((part) => !part.toLowerCase().startsWith("max-age"))
    .filter((part) => !part.toLowerCase().startsWith("expires"));
  const expires = `Expires=${new Date(0).toUTCString()}`;
  return ["", ...parts, expires].join("; ");
}

function decodeToken(jwt: string) {
  const tokenBody = jwt.split(".")[1];
  return JSON.parse(Buffer.from(tokenBody, "base64url").toString());
}

const AGENT = new Agent({ keepAlive: true });

class NonRetryableFetchError extends Error {}

export async function httpPostToCognitoWithRetry(
  url: string,
  data: Buffer,
  options: RequestOptions,
  logger: Logger
) {
  let attempts = 0;
  while (true) {
    ++attempts;
    try {
      return await fetch(url, data, {
        agent: AGENT,
        ...options,
        method: "POST",
      }).then((res) => {
        const responseData = res.data.toString();
        logger.debug(
          `Response from Cognito:`,
          JSON.stringify({
            status: res.status,
            headers: res.headers,
            data: responseData,
          })
        );
        if (!res.headers["content-type"]?.startsWith("application/json")) {
          throw new Error(
            `Content-Type is ${res.headers["content-type"]}, expected application/json`
          );
        }
        const parsedResponseData = JSON.parse(responseData);
        if (res.status !== 200) {
          const errorMessage =
            parsedResponseData.error || `Status is ${res.status}, expected 200`;
          if (res.status && res.status >= 400 && res.status < 500) {
            // No use in retrying client errors
            throw new NonRetryableFetchError(errorMessage);
          } else {
            throw new Error(errorMessage);
          }
        }
        return {
          ...res,
          data: parsedResponseData,
        };
      });
    } catch (err) {
      logger.debug(`HTTP POST to ${url} failed (attempt ${attempts}): ${err}`);
      if (err instanceof NonRetryableFetchError) {
        throw err;
      }
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
    (_: any, v: keyof typeof params) => escapeHtml(params[v]) ?? ""
  );
}

function escapeHtml(unsafe: unknown) {
  if (typeof unsafe !== "string") {
    return undefined;
  }
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
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

export class RequiresConfirmationError extends Error {}

export function generateSecret(
  allowedCharacters: string,
  secretLength: number
) {
  return [...new Array(secretLength)]
    .map(() => allowedCharacters[randomInt(0, allowedCharacters.length)])
    .join("");
}

export function ensureValidRedirectPath(path: unknown) {
  if (typeof path !== "string") return "/";
  return path.startsWith("/") ? path : `/${path}`;
}

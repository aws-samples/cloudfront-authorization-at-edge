// Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import {
  parse as parseQueryString,
  stringify as stringifyQueryString,
} from "querystring";
import { CloudFrontRequestHandler } from "aws-lambda";
import {
  getCompleteConfig,
  extractAndParseCookies,
  generateCookieHeaders,
  httpPostWithRetry,
  createErrorHtml,
  urlSafe,
  sign,
  timestampInSeconds,
  validateAndCheckIdToken,
  MissingRequiredGroupError,
} from "../shared/shared";

let CONFIG: ReturnType<typeof getCompleteConfig>;

export const handler: CloudFrontRequestHandler = async (event) => {
  if (!CONFIG) {
    CONFIG = getCompleteConfig();
    CONFIG.logger.debug("Configuration loaded:", CONFIG);
  }
  CONFIG.logger.debug("Event:", event);
  const request = event.Records[0].cf.request;
  const domainName = request.headers["host"][0].value;
  const cognitoTokenEndpoint = `https://${CONFIG.cognitoAuthDomain}/oauth2/token`;
  let redirectedFromUri = `https://${domainName}`;
  let idToken: string | undefined = undefined;
  try {
    const cookies = extractAndParseCookies(
      request.headers,
      CONFIG.clientId,
      CONFIG.cookieCompatibility
    );
    ({ idToken } = cookies);
    const { code, pkce, requestedUri } = validateQueryStringAndCookies({
      querystring: request.querystring,
      cookies,
    });
    CONFIG.logger.debug("Query string and cookies are valid");
    redirectedFromUri += requestedUri;

    const body = stringifyQueryString({
      grant_type: "authorization_code",
      client_id: CONFIG.clientId,
      redirect_uri: `https://${domainName}${CONFIG.redirectPathSignIn}`,
      code,
      code_verifier: pkce,
    });

    const requestConfig: Parameters<typeof httpPostWithRetry>[2] = {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
    };
    if (CONFIG.clientSecret) {
      const encodedSecret = Buffer.from(
        `${CONFIG.clientId}:${CONFIG.clientSecret}`
      ).toString("base64");
      requestConfig.headers.Authorization = `Basic ${encodedSecret}`;
    }
    CONFIG.logger.debug("HTTP POST to Cognito token endpoint:\n", {
      uri: cognitoTokenEndpoint,
      body,
      requestConfig,
    });
    const { status, headers, data: tokens } = await httpPostWithRetry(
      cognitoTokenEndpoint,
      body,
      requestConfig,
      CONFIG.logger
    ).catch((err) => {
      throw new Error(
        `Failed to exchange authorization code for tokens: ${err}`
      );
    });
    CONFIG.logger.info("Successfully exchanged authorization code for tokens");
    CONFIG.logger.debug("Response from Cognito token endpoint:\n", {
      status,
      headers,
      tokens,
    });

    // Validate the token and if a group is required make sure the token has it.
    // If not throw an Error or MissingRequiredGroupError
    await validateAndCheckIdToken(tokens.id_token, CONFIG);

    const response = {
      status: "307",
      statusDescription: "Temporary Redirect",
      headers: {
        location: [
          {
            key: "location",
            value: redirectedFromUri,
          },
        ],
        "set-cookie": generateCookieHeaders.newTokens({
          tokens,
          domainName,
          ...CONFIG,
        }),
        ...CONFIG.cloudFrontHeaders,
      },
    };
    CONFIG.logger.debug("Returning response:\n", response);
    return response;
  } catch (err) {
    CONFIG.logger.error(err.stack || err);
    if (idToken) {
      // There is an ID token - maybe the user signed in already (e.g. in another browser tab)
      CONFIG.logger.debug("ID token found, will check if it is valid");
      try {
        // Validate the token and if a group is required make sure the token has it.
        // If not throw an Error or MissingRequiredGroupError
        await validateAndCheckIdToken(idToken, CONFIG);

        // Return user to where he/she came from
        const response = {
          status: "307",
          statusDescription: "Temporary Redirect",
          headers: {
            location: [
              {
                key: "location",
                value: redirectedFromUri,
              },
            ],
            ...CONFIG.cloudFrontHeaders,
          },
        };
        CONFIG.logger.debug("Returning response:\n", response);
        return response;
      } catch (err) {
        CONFIG.logger.debug("ID token not valid:", err.toString());
      }
    }
    let htmlParams: Parameters<typeof createErrorHtml>[0];
    if (err instanceof RequiresConfirmationError) {
      htmlParams = {
        title: "Confirm sign-in",
        message: "We need your confirmation to sign you in –– to ensure",
        expandText: "your safety",
        details: err.toString(),
        linkUri: redirectedFromUri,
        linkText: "Confirm",
      };
    } else if (err instanceof MissingRequiredGroupError) {
      htmlParams = {
        title: "Not Authorized",
        message:
          "Your user is not authorized for this site. Please contact the admin.",
        expandText: "Click for details",
        details: err.toString(),
        linkUri: redirectedFromUri,
        linkText: "Try Again",
      };
    } else {
      htmlParams = {
        title: "Sign-in issue",
        message: "We can't sign you in because of a",
        expandText: "technical problem",
        details: err.toString(),
        linkUri: redirectedFromUri,
        linkText: "Try again",
      };
    }
    const response = {
      body: createErrorHtml(htmlParams),
      status: "200",
      headers: {
        ...CONFIG.cloudFrontHeaders,
        "content-type": [
          {
            key: "Content-Type",
            value: "text/html; charset=UTF-8",
          },
        ],
      },
    };
    CONFIG.logger.debug("Returning response:\n", response);
    return response;
  }
};

function validateQueryStringAndCookies(props: {
  querystring: string;
  cookies: ReturnType<typeof extractAndParseCookies>;
}) {
  // Check if Cognito threw an Error. Cognito puts the error in the query string
  const {
    code,
    state,
    error: cognitoError,
    error_description,
  } = parseQueryString(props.querystring);
  if (cognitoError) {
    throw new Error(`[Cognito] ${cognitoError}: ${error_description}`);
  }

  // The querystring needs to have an authorization code and state
  if (
    !code ||
    !state ||
    typeof code !== "string" ||
    typeof state !== "string"
  ) {
    throw new Error(
      [
        'Invalid query string. Your query string does not include parameters "state" and "code".',
        "This can happen if your authentication attempt did not originate from this site.",
      ].join(" ")
    );
  }

  // The querystring state should be a JSON string
  let parsedState: { nonce?: string; requestedUri?: string };
  try {
    parsedState = JSON.parse(
      Buffer.from(urlSafe.parse(state), "base64").toString()
    );
  } catch {
    throw new Error(
      'Invalid query string. Your query string does not include a valid "state" parameter'
    );
  }

  // The querystring state needs to include the right pieces
  if (!parsedState.requestedUri || !parsedState.nonce) {
    throw new Error(
      'Invalid query string. Your query string does not include a valid "state" parameter'
    );
  }

  // The querystring state needs to correlate to the cookies
  const { nonce: originalNonce, pkce, nonceHmac } = props.cookies;
  if (
    !parsedState.nonce ||
    !originalNonce ||
    parsedState.nonce !== originalNonce
  ) {
    if (!originalNonce) {
      throw new RequiresConfirmationError(
        "Your browser didn't send the nonce cookie along, but it is required for security (prevent CSRF)."
      );
    }
    throw new RequiresConfirmationError(
      "Nonce mismatch. This can happen if you start multiple authentication attempts in parallel (e.g. in separate tabs)"
    );
  }
  if (!pkce) {
    throw new Error(
      "Your browser didn't send the pkce cookie along, but it is required for security (prevent CSRF)."
    );
  }

  // Nonce should not be too old
  const nonceTimestamp = parseInt(
    parsedState.nonce.slice(0, parsedState.nonce.indexOf("T"))
  );
  if (timestampInSeconds() - nonceTimestamp > CONFIG.nonceMaxAge) {
    throw new RequiresConfirmationError(
      `Nonce is too old (nonce is from ${new Date(
        nonceTimestamp * 1000
      ).toISOString()})`
    );
  }

  // Nonce should have the right signature: proving we were the ones generating it (and e.g. not malicious JS on a subdomain)
  const calculatedHmac = sign(
    parsedState.nonce,
    CONFIG.nonceSigningSecret,
    CONFIG.nonceLength
  );
  if (calculatedHmac !== nonceHmac) {
    throw new RequiresConfirmationError(
      `Nonce signature mismatch! Expected ${calculatedHmac} but got ${nonceHmac}`
    );
  }

  return { code, pkce, requestedUri: parsedState.requestedUri || "" };
}

class RequiresConfirmationError extends Error {}

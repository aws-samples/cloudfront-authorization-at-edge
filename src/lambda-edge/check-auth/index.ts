// Copyright 2021 Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { stringify as stringifyQueryString } from "querystring";
import { createHash } from "crypto";
import { CloudFrontRequestHandler } from "aws-lambda";
import * as common from "../shared/shared";

const CONFIG = common.getConfigWithJwtVerifier();
CONFIG.logger.debug("Configuration loaded:", CONFIG);

export const handler: CloudFrontRequestHandler = async (event) => {
  CONFIG.logger.debug("Event:", event);
  const request = event.Records[0].cf.request;
  const domainName = request.headers["host"][0].value;
  const requestedUri = `${request.uri}${
    request.querystring ? "?" + request.querystring : ""
  }`;
  let refreshToken: string | undefined = "";
  let cookies: ReturnType<typeof common["extractAndParseCookies"]> = {};
  try {
    cookies = common.extractAndParseCookies(
      request.headers,
      CONFIG.clientId,
      CONFIG.cookieCompatibility
    );
    CONFIG.logger.debug("Extracted cookies:", cookies);
    refreshToken = cookies.refreshToken;

    // If there's no ID token in your cookies, then you are not signed in yet
    if (!cookies.idToken) {
      throw new Error("No ID token present in cookies");
    }

    // Verify the ID-token (JWT), this throws an error if the JWT is not valid
    const payload = await CONFIG.jwtVerifier.verify(cookies.idToken);
    CONFIG.logger.debug("JWT payload:", payload);

    // Return the request unaltered to allow access to the resource:
    CONFIG.logger.debug("Access allowed:", request);
    return request;
  } catch (err) {
    CONFIG.logger.info("Access denied:", err);

    // If the JWT is expired we can try to refresh it
    // We'll only do this if refresh did not fail earlier (detected by a marker cookie)
    // Refresh is done by redirecting the user to the refresh path (where it will actually happen)
    // If the refresh works, the user will be redirected back here (this time with valid JWTs)
    if (err instanceof common.JwtExpiredError && !cookies.refreshFailed) {
      CONFIG.logger.debug("Redirecting user to refresh path");
      return redirectToRefreshPath({ domainName, requestedUri });
    }

    // If the user is not in the right Cognito group, (s)he needs to contact an admin
    // If legitimate, the admin should add the user to the Cognito group,
    // after that the user will need to re-attempt sign-in
    if (err instanceof common.CognitoJwtInvalidGroupError) {
      CONFIG.logger.debug("User isn't in the right Cognito group");
      return showContactAdminErrorPage({ err, domainName });
    }

    // Send the user to the Cognito Hosted UI to sign-in
    CONFIG.logger.debug("Redirecting user to Cognito Hosted UI to sign-in");
    return redirectToCognitoHostedUI({ domainName, requestedUri });
  }
};

function redirectToCognitoHostedUI({
  domainName,
  requestedUri,
}: {
  domainName: string;
  requestedUri: string;
}) {
  // Generate new state which involves a signed nonce
  // This way we can check later whether the sign-in redirect was done by us (it should, to prevent CSRF attacks)
  const nonce = generateNonce();
  const state = {
    nonce,
    nonceHmac: common.sign(
      nonce,
      CONFIG.nonceSigningSecret,
      CONFIG.nonceLength
    ),
    ...generatePkceVerifier(),
  };
  CONFIG.logger.debug("Using new state\n", state);

  const loginQueryString = stringifyQueryString({
    redirect_uri: `https://${domainName}${CONFIG.redirectPathSignIn}`,
    response_type: "code",
    client_id: CONFIG.clientId,
    state:
      // Encode the state variable as base64 to avoid a bug in Cognito hosted UI when using multiple identity providers
      // Cognito decodes the URL, causing a malformed link due to the JSON string, and results in an empty 400 response from Cognito.
      common.urlSafe.stringify(
        Buffer.from(
          JSON.stringify({ nonce: state.nonce, requestedUri })
        ).toString("base64")
      ),
    scope: CONFIG.oauthScopes.join(" "),
    code_challenge_method: "S256",
    code_challenge: state.pkceHash,
  });

  // Return redirect to Cognito Hosted UI for sign-in
  const response = {
    status: "307",
    statusDescription: "Temporary Redirect",
    headers: {
      location: [
        {
          key: "location",
          value: `https://${CONFIG.cognitoAuthDomain}/oauth2/authorize?${loginQueryString}`,
        },
      ],
      "set-cookie": [
        ...getNonceCookies({ nonce, ...CONFIG }),
        {
          key: "set-cookie",
          value: `spa-auth-edge-pkce=${encodeURIComponent(state.pkce)}; ${
            CONFIG.cookieSettings.nonce
          }`,
        },
      ],
      ...CONFIG.cloudFrontHeaders,
    },
  };
  CONFIG.logger.debug("Returning response:\n", JSON.stringify(response));
  return response;
}

function redirectToRefreshPath({
  domainName,
  requestedUri,
}: {
  domainName: string;
  requestedUri: string;
}) {
  const nonce = generateNonce();
  const response = {
    status: "307",
    statusDescription: "Temporary Redirect",
    headers: {
      location: [
        {
          key: "location",
          value: `https://${domainName}${
            CONFIG.redirectPathAuthRefresh
          }?${stringifyQueryString({ requestedUri, nonce })}`,
        },
      ],
      "set-cookie": getNonceCookies({ nonce, ...CONFIG }),
      ...CONFIG.cloudFrontHeaders,
    },
  };
  CONFIG.logger.debug("Returning response:\n", JSON.stringify(response));
  return response;
}

function showContactAdminErrorPage({
  err,
  domainName,
}: {
  err: unknown;
  domainName: string;
}) {
  const response = {
    body: common.createErrorHtml({
      title: "Not Authorized",
      message:
        "You are not authorized for this site. Please contact the admin.",
      expandText: "Click for details",
      details: `${err}`,
      linkUri: `https://${domainName}${CONFIG.signOutUrl}`,
      linkText: "Try again",
    }),
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
  CONFIG.logger.debug("Returning response:\n", JSON.stringify(response));
  return response;
}

function getNonceCookies({
  nonce,
  nonceLength,
  nonceSigningSecret,
  cookieSettings,
}: {
  nonce: string;
  nonceLength: number;
  nonceSigningSecret: string;
  cookieSettings: {
    nonce: string;
  };
}) {
  return [
    {
      key: "set-cookie",
      value: `spa-auth-edge-nonce=${encodeURIComponent(nonce)}; ${
        cookieSettings.nonce
      }`,
    },
    {
      key: "set-cookie",
      value: `spa-auth-edge-nonce-hmac=${encodeURIComponent(
        common.sign(nonce, nonceSigningSecret, nonceLength)
      )}; ${cookieSettings.nonce}`,
    },
  ];
}

function generatePkceVerifier() {
  const pkce = common.generateSecret(
    CONFIG.secretAllowedCharacters,
    CONFIG.pkceLength
  );
  const verifier = {
    pkce,
    pkceHash: common.urlSafe.stringify(
      createHash("sha256").update(pkce, "utf8").digest("base64")
    ),
  };
  CONFIG.logger.debug("Generated PKCE verifier:\n", verifier);
  return verifier;
}

function generateNonce() {
  const randomString = common.generateSecret(
    CONFIG.secretAllowedCharacters,
    CONFIG.nonceLength
  );
  const nonce = `${common.timestampInSeconds()}T${randomString}`;
  CONFIG.logger.debug("Generated new nonce:", nonce);
  return nonce;
}

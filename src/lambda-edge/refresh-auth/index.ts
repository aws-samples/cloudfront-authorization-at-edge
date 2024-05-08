// Copyright 2021 Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import {
  parse as parseQueryString,
  stringify as stringifyQueryString,
} from "querystring";
import { CloudFrontRequestHandler } from "aws-lambda";
import * as common from "../shared/shared";

const CONFIG = common.getCompleteConfig();
CONFIG.logger.debug("Configuration loaded:", CONFIG);

export const handler: CloudFrontRequestHandler = async (event) => {
  CONFIG.logger.debug("Event:", event);
  const request = event.Records[0].cf.request;
  const domainName = request.headers["host"][0].value;
  let requestedUri: string | string[] | undefined = "/";
  let idToken: string | undefined = undefined;

  try {
    const querySting = parseQueryString(request.querystring);
    requestedUri = querySting.requestedUri;
    const cookies = common.extractAndParseCookies(
      request.headers,
      CONFIG.clientId,
      CONFIG.cookieCompatibility
    );
    idToken = cookies.idToken;

    validateRefreshRequest(
      querySting.nonce,
      cookies.nonceHmac,
      cookies.nonce,
      cookies.idToken,
      cookies.refreshToken
    );

    const headers: { "Content-Type": string; Authorization?: string } = {
      "Content-Type": "application/x-www-form-urlencoded",
    };

    if (CONFIG.clientSecret) {
      const encodedSecret = Buffer.from(
        `${CONFIG.clientId}:${CONFIG.clientSecret}`
      ).toString("base64");
      headers["Authorization"] = `Basic ${encodedSecret}`;
    }

    let newIdToken: string | undefined;
    let newAccessToken: string | undefined;
    const body = stringifyQueryString({
      grant_type: "refresh_token",
      client_id: CONFIG.clientId,
      refresh_token: cookies.refreshToken,
    });
    const res = await common
      .httpPostToCognitoWithRetry(
        `https://${CONFIG.cognitoAuthDomain}/oauth2/token`,
        Buffer.from(body),
        { headers },
        CONFIG.logger
      )
      .catch((err) => {
        throw new Error(`Failed to refresh tokens: ${err}`);
      });
    CONFIG.logger.info("Successfully renewed tokens");
    newIdToken = res.data.id_token as string;
    newAccessToken = res.data.access_token as string;
    const response = {
      status: "307",
      statusDescription: "Temporary Redirect",
      headers: {
        location: [
          {
            key: "location",
            value: `https://${domainName}${common.ensureValidRedirectPath(
              requestedUri
            )}`,
          },
        ],
        "set-cookie": common.generateCookieHeaders.refresh({
          ...CONFIG,
          tokens: { id: newIdToken, access: newAccessToken },
        }),
        ...CONFIG.cloudFrontHeaders,
      },
    };
    CONFIG.logger.debug("Returning response:\n", JSON.stringify(response));
    return response;
  } catch (err) {
    if (
      err instanceof Error &&
      err.message.includes("invalid_grant") &&
      idToken
    ) {
      // The refresh token has likely expired.
      // We'll clear the refresh token cookie, so that CheckAuth won't redirect any more requests here in vain.
      // Also, we'll redirect the user to where he/she came from.
      // (From there CheckAuth will redirect the user to the Cognito hosted UI to sign in)
      CONFIG.logger.info(
        "Expiring refresh token cookie, as the refresh token has expired"
      );
      const response = {
        status: "307",
        statusDescription: "Temporary Redirect",
        headers: {
          location: [
            {
              key: "location",
              value: `https://${domainName}${common.ensureValidRedirectPath(
                requestedUri
              )}`,
            },
          ],
          "set-cookie": common.generateCookieHeaders.refreshFailed({
            tokens: {
              id: idToken,
            },
            ...CONFIG,
          }),
          ...CONFIG.cloudFrontHeaders,
        },
      };
      CONFIG.logger.debug("Returning response:\n", JSON.stringify(response));
      return response;
    }
    CONFIG.logger.error(err);
    const response = {
      body: common.createErrorHtml({
        title: "Refresh issue",
        message: "We can't refresh your sign-in automatically because of a",
        expandText: "technical problem",
        details: `${err}`,
        linkUri: `https://${domainName}${CONFIG.signOutUrl}`,
        linkText: "Sign in",
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
};

function validateRefreshRequest(
  currentNonce?: string | string[],
  nonceHmac?: string,
  originalNonce?: string,
  idToken?: string,
  refreshToken?: string
) {
  if (!originalNonce) {
    throw new Error(
      "Your browser didn't send the nonce cookie along, but it is required for security (prevent CSRF)."
    );
  }
  if (currentNonce !== originalNonce) {
    throw new Error("Nonce mismatch");
  }
  if (!idToken) {
    throw new Error("Missing ID token");
  }
  if (!refreshToken) {
    throw new Error("Missing refresh token");
  }
  // Nonce should not be too old
  const nonceTimestamp = parseInt(
    currentNonce.slice(0, currentNonce.indexOf("T"))
  );
  if (common.timestampInSeconds() - nonceTimestamp > CONFIG.nonceMaxAge) {
    throw new common.RequiresConfirmationError(
      `Nonce is too old (nonce is from ${new Date(
        nonceTimestamp * 1000
      ).toISOString()})`
    );
  }

  // Nonce should have the right signature: proving we were the ones generating it (and e.g. not malicious JS on a subdomain)
  const calculatedHmac = common.sign(
    currentNonce,
    CONFIG.nonceSigningSecret,
    CONFIG.nonceLength
  );
  if (calculatedHmac !== nonceHmac) {
    throw new common.RequiresConfirmationError(
      `Nonce signature mismatch! Expected ${calculatedHmac} but got ${nonceHmac}`
    );
  }
}

// Copyright 2021 Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { stringify as stringifyQueryString } from "querystring";
import { CloudFrontRequestHandler } from "aws-lambda";
import {
  getCompleteConfig,
  extractAndParseCookies,
  generateCookieHeaders,
  createErrorHtml,
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
  const cookies = extractAndParseCookies(
    request.headers,
    CONFIG.clientId,
    CONFIG.cookieCompatibility
  );

  if (!cookies.idToken) {
    const response = {
      body: createErrorHtml({
        title: "Signed out",
        message: "You are already signed out",
        linkUri: `https://${domainName}${CONFIG.redirectPathSignOut}`,
        linkText: "Proceed",
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

  const qs = {
    logout_uri: `https://${domainName}${CONFIG.redirectPathSignOut}`,
    client_id: CONFIG.clientId,
  };

  const response = {
    status: "307",
    statusDescription: "Temporary Redirect",
    headers: {
      location: [
        {
          key: "location",
          value: `https://${
            CONFIG.cognitoAuthDomain
          }/logout?${stringifyQueryString(qs)}`,
        },
      ],
      "set-cookie": generateCookieHeaders.signOut({
        tokens: {
          id: cookies.idToken,
        },
        ...CONFIG,
      }),
      ...CONFIG.cloudFrontHeaders,
    },
  };
  CONFIG.logger.debug("Returning response:\n", JSON.stringify(response));
  return response;
};

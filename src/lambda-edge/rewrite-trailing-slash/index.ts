// Copyright 2021 Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { CloudFrontRequestHandler } from "aws-lambda";
import { getConfig } from "../shared/shared";

const CONFIG = getConfig();
CONFIG.logger.debug("Configuration loaded:", CONFIG);

export const handler: CloudFrontRequestHandler = async (event) => {
  CONFIG.logger.debug("Event:", event);
  const request = event.Records[0].cf.request;
  if (request.uri.endsWith("/")) {
    request.uri += "index.html";
  }
  CONFIG.logger.debug("Returning request:\n", request);
  return request;
};

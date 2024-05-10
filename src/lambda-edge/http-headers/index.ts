// Copyright 2021 Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { CloudFrontResponseHandler } from "aws-lambda";
import * as common from "../shared/shared";

const CONFIG = common.getConfigWithHeaders();
CONFIG.logger.debug("Configuration loaded:", CONFIG);

export const handler: CloudFrontResponseHandler = async (event) => {
  CONFIG.logger.debug("Event:", event);
  const response = event.Records[0].cf.response;
  Object.assign(response.headers, CONFIG.cloudFrontHeaders);
  CONFIG.logger.debug("Returning response:\n", JSON.stringify(response));
  return response;
};

// Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { CloudFrontResponseHandler } from 'aws-lambda';
import { getConfig } from '../shared/shared';


const { logger, ...CONFIG } = getConfig();

export const handler: CloudFrontResponseHandler = async (event) => {
    logger.debug(event);
    const response = event.Records[0].cf.response;
    Object.assign(response.headers, CONFIG.cloudFrontHeaders);
    logger.debug('Returning response:\n', response);
    return response;
}

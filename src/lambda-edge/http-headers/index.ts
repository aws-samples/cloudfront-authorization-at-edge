// Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { CloudFrontResponseHandler } from 'aws-lambda';
import { getConfig } from '../shared/shared';


let CONFIG: ReturnType<typeof getConfig>;

export const handler: CloudFrontResponseHandler = async (event) => {
    if (!CONFIG || process.env.IS_TEST_MODE) {
        CONFIG = getConfig();
    }
    CONFIG.logger.debug(event);
    const response = event.Records[0].cf.response;
    Object.assign(response.headers, CONFIG.cloudFrontHeaders);
    CONFIG.logger.debug('Returning response:\n', response);
    return response;
}

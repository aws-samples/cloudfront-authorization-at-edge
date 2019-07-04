// Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { readFileSync } from 'fs';
import { CloudFrontResponseHandler, CloudFrontHeaders } from 'aws-lambda';
import { HttpHeaders, asCloudFrontHeaders } from '../shared/shared';


const configuredHeaders = getConfiguredHeaders();

export const handler: CloudFrontResponseHandler = async (event) => {
    const resp = event.Records[0].cf.response;
    Object.assign(resp.headers, configuredHeaders);
    return resp;
}

function getConfiguredHeaders(): CloudFrontHeaders {
    const headers = JSON.parse(readFileSync(`${__dirname}/configuration.json`).toString('utf8')) as HttpHeaders;
    return asCloudFrontHeaders(headers);
}

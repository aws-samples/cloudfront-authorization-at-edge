// Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import {
    CloudFormationCustomResourceHandler,
    CloudFormationCustomResourceResponse,
    CloudFormationCustomResourceDeleteEvent,
    CloudFormationCustomResourceUpdateEvent
} from 'aws-lambda';
import axios from 'axios';
import staticSiteUpload from 's3-spa-upload';
import { mkdirSync } from 'fs';


interface Configuration {
    BucketName: string;
}


async function uploadPages(action: 'Create' | 'Update' | 'Delete', config: Configuration, physicalResourceId?: string) {
    if (action === 'Create' || action === 'Update') {
        await staticSiteUpload(`${__dirname}/pages`, config.BucketName);
    } else {
        // "Trick" to empty the bucket is to upload an empty dir
        mkdirSync('/tmp/empty_directory', { recursive: true });
        await staticSiteUpload('/tmp/empty_directory', config.BucketName, { delete: true });
    }
    return physicalResourceId || "StaticSite";
}

export const handler: CloudFormationCustomResourceHandler = async (event, context) => {
    console.log(JSON.stringify(event, undefined, 4));

    const {
        LogicalResourceId,
        RequestId,
        StackId,
        ResponseURL,
        ResourceProperties,
        RequestType,
    } = event;

    const { ServiceToken, ...config } = ResourceProperties;

    const { PhysicalResourceId } = event as CloudFormationCustomResourceDeleteEvent | CloudFormationCustomResourceUpdateEvent;

    let response: CloudFormationCustomResourceResponse;
    try {
        const physicalResourceId = await Promise.race([
            uploadPages(RequestType, config as Configuration, PhysicalResourceId),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Task timeout')), context.getRemainingTimeInMillis() - 500))
        ]);
        response = {
            LogicalResourceId,
            PhysicalResourceId: physicalResourceId as string,
            Status: 'SUCCESS',
            RequestId,
            StackId,
            Data: {}
        };
    } catch (err) {
        console.error(err);
        response = {
            LogicalResourceId,
            PhysicalResourceId: PhysicalResourceId || `failed-to-create-${Date.now()}`,
            Status: 'FAILED',
            Reason: err.stack || err.message,
            RequestId,
            StackId,
        };
    }
    await axios.put(ResponseURL, response, { headers: { 'content-type': '' } });
}

// Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import {
    CloudFormationCustomResourceHandler,
    CloudFormationCustomResourceResponse,
    CloudFormationCustomResourceDeleteEvent,
    CloudFormationCustomResourceUpdateEvent
} from 'aws-lambda';
import axios from 'axios';
import Lambda from 'aws-sdk/clients/lambda';
import Zip from 'adm-zip';

const LAMBDA_CLIENT = new Lambda({ region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION });

async function updateLambdaCode(action: 'Create' | 'Update' | 'Delete', lambdaFunction: string, configuration: string, physicalResourceId?: string) {
    if (action === 'Delete') {
        // Deletes aren't executed; the Lambda Resource should just be deleted
        return { physicalResourceId: physicalResourceId!, Data: {} };
    }
    console.log(`Adding configuration to Lambda function ${lambdaFunction}:\n${configuration}`);
    const { Code } = await LAMBDA_CLIENT.getFunction({ FunctionName: lambdaFunction }).promise();
    const { data } = await axios.get(Code!.Location!, { responseType: 'arraybuffer' });
    const ZipFile = new Zip(data);
    ZipFile.addFile('configuration.json', Buffer.from(configuration));
    const { CodeSha256, Version, FunctionArn } = await LAMBDA_CLIENT.updateFunctionCode(
        {
            FunctionName: lambdaFunction,
            ZipFile: ZipFile.toBuffer(),
            Publish: true
        }
    ).promise();
    console.log({ CodeSha256, Version, FunctionArn });
    return { physicalResourceId: lambdaFunction, Data: { CodeSha256, Version, FunctionArn } };
}

export const handler: CloudFormationCustomResourceHandler = async (event) => {
    const {
        LogicalResourceId,
        RequestId,
        StackId,
        ResponseURL,
        ResourceProperties,
        RequestType,
    } = event;

    const { PhysicalResourceId } = event as CloudFormationCustomResourceDeleteEvent | CloudFormationCustomResourceUpdateEvent;

    const { LambdaFunction, Configuration } = ResourceProperties;

    let response: CloudFormationCustomResourceResponse;
    try {
        const { physicalResourceId, Data } = await updateLambdaCode(RequestType, LambdaFunction, Configuration, PhysicalResourceId);
        response = {
            LogicalResourceId,
            PhysicalResourceId: physicalResourceId,
            Status: 'SUCCESS',
            RequestId,
            StackId,
            Data,
        };
    } catch (err) {
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

// Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import {
    CloudFormationCustomResourceHandler,
    CloudFormationCustomResourceResponse,
    CloudFormationCustomResourceDeleteEvent,
    CloudFormationCustomResourceUpdateEvent,
} from 'aws-lambda';
import axios from 'axios';
import CognitoIdentityServiceProvider from 'aws-sdk/clients/cognitoidentityserviceprovider';

const COGNITO_CLIENT = new CognitoIdentityServiceProvider({
    region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION,
});

async function retrieveClientSecret(
    action: 'Create' | 'Update' | 'Delete',
    userPoolId: string,
    clientId: string,
    physicalResourceId?: string,
) {
    if (action === 'Delete') {
        // Deletes aren't executed; the standard Resource should just be deleted
        return { physicalResourceId: physicalResourceId };
    }
    const input: CognitoIdentityServiceProvider.Types.DescribeUserPoolClientRequest = {
        UserPoolId: userPoolId,
        ClientId: clientId,
    };
    const res = await COGNITO_CLIENT.describeUserPoolClient(input).promise();
    return {
        physicalResourceId: `${userPoolId}-${clientId}-retrieved-client-secret`,
        Data: { ClientSecret: res.UserPoolClient!.ClientSecret || '' },
    };
}

export const handler: CloudFormationCustomResourceHandler = async (event) => {
    console.log(JSON.stringify(event, undefined, 4));
    const { LogicalResourceId, RequestId, StackId, ResponseURL, ResourceProperties, RequestType } = event;

    const { PhysicalResourceId } = event as
        | CloudFormationCustomResourceDeleteEvent
        | CloudFormationCustomResourceUpdateEvent;

    const { UserPoolId, UserPoolClientId } = ResourceProperties;

    let response: CloudFormationCustomResourceResponse;
    try {
        const { physicalResourceId, Data } = await retrieveClientSecret(RequestType, UserPoolId, UserPoolClientId);
        console.log(physicalResourceId);
        console.log(Data);
        response = {
            LogicalResourceId,
            PhysicalResourceId: physicalResourceId!,
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
};

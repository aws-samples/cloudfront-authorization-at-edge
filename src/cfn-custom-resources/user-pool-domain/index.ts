/*
    Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.
    SPDX-License-Identifier: MIT-0

    This is a CloudFormation custom resource. It's purpose is to:

    - Lookup the URL of an existing User Pool Domain

    We need to do this in a custom resource to support the scenario of looking up a pre-existing User Pool Domain
*/


import {
    CloudFormationCustomResourceHandler,
    CloudFormationCustomResourceResponse,
    CloudFormationCustomResourceDeleteEvent,
    CloudFormationCustomResourceUpdateEvent
} from 'aws-lambda';
import axios from 'axios';
import CognitoIdentityServiceProvider from 'aws-sdk/clients/cognitoidentityserviceprovider';


async function ensureCognitoUserPoolDomain(action: 'Create' | 'Update' | 'Delete', newUserPoolArn: string, physicalResourceId?: string) {
    if (action === 'Delete') {
        return physicalResourceId!;
    }
    const newUserPoolId = newUserPoolArn.split('/')[1];
    const newUserPoolRegion = newUserPoolArn.split(':')[3];
    const cognitoClient = new CognitoIdentityServiceProvider({ region: newUserPoolRegion });
    const { UserPool } = await cognitoClient.describeUserPool({ UserPoolId: newUserPoolId }).promise();
    if (!UserPool) {
        throw new Error(`User Pool ${newUserPoolArn} does not exist`);
    }
    if (UserPool.CustomDomain) {
        return UserPool.CustomDomain;
    } else if (UserPool.Domain) {
        return `${UserPool.Domain}.auth.${newUserPoolRegion}.amazoncognito.com`;
    } else {
        throw new Error(`User Pool ${newUserPoolArn} does not have a domain set up yet`);
    }
}

export const handler: CloudFormationCustomResourceHandler = async (event) => {
    console.log(JSON.stringify(event, undefined, 4));
    const {
        LogicalResourceId,
        RequestId,
        StackId,
        ResponseURL,
        ResourceProperties,
        RequestType,
    } = event;

    const { PhysicalResourceId } = event as CloudFormationCustomResourceDeleteEvent | CloudFormationCustomResourceUpdateEvent;

    let response: CloudFormationCustomResourceResponse;
    try {
        const physicalResourceId = await ensureCognitoUserPoolDomain(RequestType, ResourceProperties.UserPoolArn, PhysicalResourceId);
        response = {
            LogicalResourceId,
            PhysicalResourceId: physicalResourceId,
            Status: 'SUCCESS',
            RequestId,
            StackId
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

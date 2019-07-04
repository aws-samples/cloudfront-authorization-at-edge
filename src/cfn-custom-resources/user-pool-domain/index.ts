// Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { randomBytes } from 'crypto';
import {
    CloudFormationCustomResourceHandler,
    CloudFormationCustomResourceResponse,
    CloudFormationCustomResourceDeleteEvent,
    CloudFormationCustomResourceUpdateEvent
} from 'aws-lambda';
import axios from 'axios';
import CognitoIdentityServiceProvider from 'aws-sdk/clients/cognitoidentityserviceprovider';

const COGNITO_CLIENT = new CognitoIdentityServiceProvider({ region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION });

async function ensureCognitoUserPoolDomain(action: 'Create' | 'Update' | 'Delete', newUserPoolId: string, physicalResourceId?: string) {
    const decodedPhysicalResourceId = decodePhysicalResourceId(physicalResourceId!);
    let returnPhysicalResourceId: string;
    let domainName: string | undefined;
    if (action === 'Delete') {
        if (decodedPhysicalResourceId) {
            const { userPoolId: oldUserPoolId, domainPrefix: oldDomainPrefix } = decodedPhysicalResourceId;
            const input: CognitoIdentityServiceProvider.CreateUserPoolDomainRequest = {
                Domain: oldDomainPrefix,
                UserPoolId: oldUserPoolId,
            };
            await COGNITO_CLIENT.deleteUserPoolDomain(input).promise();
        } else {
            console.warn(`Can't delete ${physicalResourceId} as it can't be decoded`);
        }
        returnPhysicalResourceId = physicalResourceId!;
    } else if (action === 'Create' || action === 'Update') {
        const randomValue = decodedPhysicalResourceId && decodedPhysicalResourceId.randomValue || randomBytes(4).toString('hex');
        const domainPrefix = `auth-${randomValue}`;
        const existingDomain = await COGNITO_CLIENT.describeUserPoolDomain({ Domain: domainPrefix }).promise();
        if (action === 'Create' || !existingDomain.DomainDescription || !existingDomain.DomainDescription!.CustomDomainConfig!) {
            const input: CognitoIdentityServiceProvider.CreateUserPoolDomainRequest = {
                Domain: domainPrefix,
                UserPoolId: newUserPoolId,
            };
            await COGNITO_CLIENT.createUserPoolDomain(input).promise();
        }
        domainName = `${domainPrefix}.auth.${COGNITO_CLIENT.config.region}.amazoncognito.com`;
        returnPhysicalResourceId = encodePhysicalResourceId(newUserPoolId, domainPrefix, randomValue);
    }
    return { domainName, physicalResourceId: returnPhysicalResourceId! };
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

    let response: CloudFormationCustomResourceResponse;
    try {
        const { domainName, physicalResourceId } = await ensureCognitoUserPoolDomain(RequestType, ResourceProperties.UserPoolId, PhysicalResourceId);
        response = {
            LogicalResourceId,
            PhysicalResourceId: physicalResourceId,
            Status: 'SUCCESS',
            RequestId,
            StackId,
            Data: {
                DomainName: domainName,
            }
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

function encodePhysicalResourceId(userPoolId: string, domainPrefix: string, randomValue: string) {
    const obj = { userPoolId, domainPrefix, randomValue };
    return JSON.stringify(obj, Object.keys(obj).sort());
}

function decodePhysicalResourceId(physicalResourceId: string) {
    try {
        return JSON.parse(physicalResourceId) as { userPoolId: string; domainPrefix: string; randomValue: string; };
    } catch (err) {
        console.error(`Can't parse physicalResourceId: ${physicalResourceId}`);
    }
}

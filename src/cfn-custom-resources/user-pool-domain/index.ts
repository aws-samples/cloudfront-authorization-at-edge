/*
    Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.
    SPDX-License-Identifier: MIT-0

    This is a CloudFormation custom resource. It's purpose is to:

    - Create a User Pool domain for a User Pool (to enable the Cognito Hosted UI)
    - Lookup the URL of an existing User Pool Domain

    We need to do this in a custom resource to support the scenario of looking up a pre-existing User Pool Domain
*/


import { randomBytes } from 'crypto';
import {
    CloudFormationCustomResourceHandler,
    CloudFormationCustomResourceResponse,
    CloudFormationCustomResourceDeleteEvent,
    CloudFormationCustomResourceUpdateEvent
} from 'aws-lambda';
import axios from 'axios';
import CognitoIdentityServiceProvider from 'aws-sdk/clients/cognitoidentityserviceprovider';


async function ensureCognitoUserPoolDomain(action: 'Create' | 'Update' | 'Delete', newUserPoolArn: string, physicalResourceId?: string) {
    const createdPhysicalResource = decodePhysicalResourceId(physicalResourceId!);
    let returnPhysicalResourceId: string;
    let domainName: string | undefined;
    const newUserPoolId = newUserPoolArn.split('/')[1];
    const newUserPoolRegion = newUserPoolArn.split(':')[3];

    if (action === 'Delete') {
        // If we created the User Pool Domain earlier,
        // then we'll clean up after ourselves and delete it
        if (createdPhysicalResource) {
            const { userPoolArn: oldUserPoolArn, domainPrefix: oldDomainPrefix } = createdPhysicalResource;
            const oldUserPoolRegion = oldUserPoolArn.split(':')[3];
            const oldUserPoolId = oldUserPoolArn.split('/')[1];
            const input: CognitoIdentityServiceProvider.CreateUserPoolDomainRequest = {
                Domain: oldDomainPrefix,
                UserPoolId: oldUserPoolId,
            };
            await new CognitoIdentityServiceProvider({ region: oldUserPoolRegion }).deleteUserPoolDomain(input).promise();
        } else {
            console.warn(`Won't delete ${physicalResourceId}`);
        }
        returnPhysicalResourceId = physicalResourceId!;
    } else if (action === 'Create' || action === 'Update') {
        const cognitoClient = new CognitoIdentityServiceProvider({ region: newUserPoolRegion });
        const existingUserPool = await cognitoClient.describeUserPool({ UserPoolId: newUserPoolId }).promise();
        const domainPrefix = existingUserPool.UserPool?.Domain;
        const customDomain = existingUserPool.UserPool?.CustomDomain;
        if (customDomain) {
            returnPhysicalResourceId = domainName = customDomain;
        } else if (domainPrefix) {
            returnPhysicalResourceId = domainName = `${domainPrefix}.auth.${newUserPoolRegion}.amazoncognito.com`;
        } else {
            const domainPrefix = `auth-${randomBytes(4).toString('hex')}`;
            const cognitoClient = new CognitoIdentityServiceProvider({ region: newUserPoolRegion });
            const input: CognitoIdentityServiceProvider.CreateUserPoolDomainRequest = {
                Domain: domainPrefix,
                UserPoolId: newUserPoolId,
            };
            await cognitoClient.createUserPoolDomain(input).promise();
            domainName = `${domainPrefix}.auth.${cognitoClient.config.region}.amazoncognito.com`;
            returnPhysicalResourceId = encodePhysicalResourceId({
                domainPrefix, userPoolArn: newUserPoolArn
            });
        }
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
        const { domainName, physicalResourceId } = await ensureCognitoUserPoolDomain(RequestType, ResourceProperties.UserPoolArn, PhysicalResourceId);
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

interface CreatedPhysicalResourceId {
    userPoolArn: string;
    domainPrefix: string;
}

function encodePhysicalResourceId(obj: CreatedPhysicalResourceId) {
    return JSON.stringify(obj, Object.keys(obj).sort());
}

function decodePhysicalResourceId(physicalResourceId: string) {
    try {
        return JSON.parse(physicalResourceId) as CreatedPhysicalResourceId
    } catch (err) {
        console.error(`Can't parse physicalResourceId: ${physicalResourceId}`);
    }
}

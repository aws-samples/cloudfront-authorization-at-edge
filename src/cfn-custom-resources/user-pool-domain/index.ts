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


async function ensureCognitoUserPoolDomain(action: 'Create' | 'Update' | 'Delete', newUserPoolArn: string, createOrLookup: 'Create' | 'Lookup', physicalResourceId?: string) {
    const decodedPhysicalResourceId = decodePhysicalResourceId(physicalResourceId!);
    let returnPhysicalResourceId: string;
    let domainName: string | undefined;
    const newUserPoolId = newUserPoolArn.split('/')[1];
    const newUserPoolRegion = newUserPoolArn.split(':')[3];
    if (action === 'Delete') {
        if (decodedPhysicalResourceId && decodedPhysicalResourceId.createOrLookup === 'Create') {
            const { userPoolArn: oldUserPoolArn, domainPrefix: oldDomainPrefix } = decodedPhysicalResourceId;
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
        let domainPrefix: string;
        if (createOrLookup === 'Create') {
            domainPrefix = decodedPhysicalResourceId?.domainPrefix || `auth-${randomBytes(4).toString('hex')}`;
            const cognitoClient = new CognitoIdentityServiceProvider();
            const existingDomain = await cognitoClient.describeUserPoolDomain({ Domain: domainPrefix }).promise();
            if (action === 'Create' || !existingDomain.DomainDescription || !existingDomain.DomainDescription!.CustomDomainConfig!) {
                const input: CognitoIdentityServiceProvider.CreateUserPoolDomainRequest = {
                    Domain: domainPrefix,
                    UserPoolId: newUserPoolId,
                };
                await cognitoClient.createUserPoolDomain(input).promise();
            }
            domainName = `${domainPrefix}.auth.${cognitoClient.config.region}.amazoncognito.com`;
        } else {
            const cognitoClient = new CognitoIdentityServiceProvider({ region: newUserPoolRegion });
            const existingUserPool = await cognitoClient.describeUserPool({ UserPoolId: newUserPoolId }).promise();
            domainPrefix = existingUserPool.UserPool?.Domain || '';
            if (!domainPrefix) {
                throw new Error('When using an existing user pool, that user pool should have a domain set up already');
            }
            domainName = `${domainPrefix}.auth.${newUserPoolRegion}.amazoncognito.com`;
        }
        returnPhysicalResourceId = encodePhysicalResourceId({
            createOrLookup, domainPrefix, userPoolArn: newUserPoolArn
        });
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
        const { domainName, physicalResourceId } = await ensureCognitoUserPoolDomain(RequestType, ResourceProperties.UserPoolArn, ResourceProperties.CreateOrLookup, PhysicalResourceId);
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

function encodePhysicalResourceId(obj: { userPoolArn: string, domainPrefix: string, createOrLookup: 'Create' | 'Lookup' }) {
    return JSON.stringify(obj, Object.keys(obj).sort());
}

function decodePhysicalResourceId(physicalResourceId: string) {
    try {
        return JSON.parse(physicalResourceId) as { userPoolArn: string; domainPrefix: string; createOrLookup: 'Create' | 'Lookup' };
    } catch (err) {
        console.error(`Can't parse physicalResourceId: ${physicalResourceId}`);
    }
}

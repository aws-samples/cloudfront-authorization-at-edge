// Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import {
    CloudFormationCustomResourceHandler,
    CloudFormationCustomResourceResponse,
    CloudFormationCustomResourceDeleteEvent,
    CloudFormationCustomResourceUpdateEvent
} from 'aws-lambda';
import axios from 'axios';
import CognitoIdentityServiceProvider from 'aws-sdk/clients/cognitoidentityserviceprovider';

const COGNITO_CLIENT = new CognitoIdentityServiceProvider({ region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION });

async function ensureCognitoUserPoolClient(
    action: 'Create' | 'Update' | 'Delete',
    userPoolId: string,
    clientId: string,
    oAuthScopes: string,
    cloudFrontDistributionDomainName: string,
    redirectPathSignIn: string,
    redirectPathSignOut: string,
    alternateDomainNames: string[],
    physicalResourceId?: string) {
    if (action === 'Delete') {
        // Deletes aren't executed; the standard UserPool client CFN Resource should just be deleted
        return { physicalResourceId: physicalResourceId! };
    }
    const redirectDomains = [cloudFrontDistributionDomainName, ...alternateDomainNames].filter(domain => !!domain);
    if (!redirectDomains.length) {
        // Provide dummy value to be able to proceed
        // Should be obvious to user to update this later
        redirectDomains.push('example.org');
    }
    const RedirectUrisSignIn = redirectDomains.map(domain => `https://${domain}${redirectPathSignIn}`);
    const RedirectUrisSignOut = redirectDomains.map(domain => `https://${domain}${redirectPathSignOut}`);
    const input: CognitoIdentityServiceProvider.Types.UpdateUserPoolClientRequest = {
        AllowedOAuthFlows: ['code'],
        AllowedOAuthFlowsUserPoolClient: true,
        SupportedIdentityProviders: ['COGNITO'],
        AllowedOAuthScopes: JSON.parse(oAuthScopes),
        ClientId: clientId,
        CallbackURLs: RedirectUrisSignIn,
        LogoutURLs: RedirectUrisSignOut,
        UserPoolId: userPoolId,
    };
    await COGNITO_CLIENT.updateUserPoolClient(input).promise();
    return {
        physicalResourceId: `${userPoolId}-${clientId}-updated-client`,
        Data: {
            RedirectUrisSignIn: RedirectUrisSignIn.join(','),
            RedirectUrisSignOut: RedirectUrisSignOut.join(','),
        }
    };
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

    const { UserPoolId, UserPoolClientId, OAuthScopes, CloudFrontDistributionDomainName, RedirectPathSignIn, RedirectPathSignOut, AlternateDomainNames } = ResourceProperties;

    let response: CloudFormationCustomResourceResponse;
    try {
        const { physicalResourceId, Data } = await ensureCognitoUserPoolClient(
            RequestType, UserPoolId, UserPoolClientId, OAuthScopes, CloudFrontDistributionDomainName, RedirectPathSignIn, RedirectPathSignOut, AlternateDomainNames, PhysicalResourceId);
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

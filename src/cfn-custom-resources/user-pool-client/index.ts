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


async function ensureCognitoUserPoolClient(
    action: 'Create' | 'Update' | 'Delete',
    userPoolArn: string,
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
    const userPoolId = userPoolArn.split('/')[1];
    const userPoolRegion = userPoolArn.split(':')[3];
    const cognitoClient = new CognitoIdentityServiceProvider({ region: userPoolRegion });
    const redirectDomains = [cloudFrontDistributionDomainName, ...alternateDomainNames].filter(domain => !!domain);
    if (!redirectDomains.length) {
        // Provide dummy value to be able to proceed
        // Should be obvious to user to update this later
        redirectDomains.push('example.org');
    }
    // Fetch existing callback URL's -- we want to keep them
    const { UserPoolClient } = await cognitoClient.describeUserPoolClient({
        ClientId: clientId, UserPoolId: userPoolId
    }).promise();
    const existingRedirectUrisSignIn = UserPoolClient?.CallbackURLs || [];
    const exitsingRedirectUrisSignOut = UserPoolClient?.LogoutURLs || [];

    // Combine existing callback URL's with the one we calculated
    const RedirectUrisSignIn = [...redirectDomains.map(domain => `https://${domain}${redirectPathSignIn}`), ...existingRedirectUrisSignIn];
    const RedirectUrisSignOut = [...redirectDomains.map(domain => `https://${domain}${redirectPathSignOut}`), ...exitsingRedirectUrisSignOut];

    // Deduplicate
    const RedirectUrisSignInDeduplicated = [...new Set(RedirectUrisSignIn)];
    const RedirectUrisSignOutDeduplicated = [...new Set(RedirectUrisSignOut)];

    const input: CognitoIdentityServiceProvider.Types.UpdateUserPoolClientRequest = {
        AllowedOAuthFlows: ['code'],
        AllowedOAuthFlowsUserPoolClient: true,
        SupportedIdentityProviders: ['COGNITO'],
        AllowedOAuthScopes: JSON.parse(oAuthScopes),
        ClientId: clientId,
        CallbackURLs: RedirectUrisSignInDeduplicated,
        LogoutURLs: RedirectUrisSignOutDeduplicated,
        UserPoolId: userPoolId,
    };
    await cognitoClient.updateUserPoolClient(input).promise();
    return {
        physicalResourceId: `${userPoolId}-${clientId}-updated-client`,
        Data: {
            RedirectUrisSignIn: RedirectUrisSignInDeduplicated.join(','),
            RedirectUrisSignOut: RedirectUrisSignOutDeduplicated.join(','),
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

    const { UserPoolArn, UserPoolClientId, OAuthScopes, CloudFrontDistributionDomainName, RedirectPathSignIn, RedirectPathSignOut, AlternateDomainNames } = ResourceProperties;

    let response: CloudFormationCustomResourceResponse;
    try {
        const { physicalResourceId, Data } = await ensureCognitoUserPoolClient(
            RequestType, UserPoolArn, UserPoolClientId, OAuthScopes, CloudFrontDistributionDomainName, RedirectPathSignIn, RedirectPathSignOut, AlternateDomainNames, PhysicalResourceId);
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

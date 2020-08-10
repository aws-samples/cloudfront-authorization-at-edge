/*
    Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.
    SPDX-License-Identifier: MIT-0

    This is a CloudFormation custom resource. It's purpose is to:

    - Update a User Pool Client's redirect URL's

    We need to do this in a custom resource, to support the scenario of updating a pre-existing User Pool Client
*/

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

    // Fetch existing callback URLs.
    // We want to keep them to achieve compatibility with Amazon Elasticsearch Service (special case)
    // This is because Amazon Elasticsearch Service integrates with Cognito, but creates it's own
    // User Pool Clien then, and needs the callback URL's to remain the same (so that it can refresh tokens)
    const { UserPoolClient } = await cognitoClient.describeUserPoolClient({
        ClientId: clientId, UserPoolId: userPoolId
    }).promise();
    const existingRedirectUrisSignIn = (UserPoolClient?.CallbackURLs || []).filter(url => url.includes("es.amazonaws.com"));
    const exitsingRedirectUrisSignOut = (UserPoolClient?.LogoutURLs || []).filter(url => url.includes("es.amazonaws.com"));

    // Combine existing callback URL's with the ones we calculated
    const RedirectUrisSignIn = [...redirectDomains.map(domain => `https://${domain}${redirectPathSignIn}`), ...existingRedirectUrisSignIn];
    const RedirectUrisSignOut = [...redirectDomains.map(domain => `https://${domain}${redirectPathSignOut}`), ...exitsingRedirectUrisSignOut];

    // Deduplicate entries
    const RedirectUrisSignInDeduplicated = [...new Set(RedirectUrisSignIn)];
    const RedirectUrisSignOutDeduplicated = [...new Set(RedirectUrisSignOut)];

    // Provide dummy value if needed, to be able to proceed
    // Should be obvious to user to update this later
    if (!RedirectUrisSignInDeduplicated.length) {
        RedirectUrisSignInDeduplicated.push(`https://example.org/${redirectPathSignIn}`);
    }
    if (!RedirectUrisSignOutDeduplicated.length) {
        RedirectUrisSignOutDeduplicated.push(`https://example.org/${redirectPathSignOut}`);
    }

    // And finally, update the user ppol client
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

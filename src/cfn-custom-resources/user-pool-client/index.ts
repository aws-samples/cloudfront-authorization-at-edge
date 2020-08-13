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

    const userPoolId = userPoolArn.split('/')[1];
    const userPoolRegion = userPoolArn.split(':')[3];
    const cognitoClient = new CognitoIdentityServiceProvider({ region: userPoolRegion });
    const redirectDomains = [cloudFrontDistributionDomainName, ...alternateDomainNames].filter(domain => !!domain);

    // Fetch existing callback URLs––we wan't to keep them and just add new entries that we need ourselves
    const { UserPoolClient } = await cognitoClient.describeUserPoolClient({
        ClientId: clientId, UserPoolId: userPoolId
    }).promise();
    const existingRedirectUrisSignIn = UserPoolClient?.CallbackURLs || [];
    const existingRedirectUrisSignOut = UserPoolClient?.LogoutURLs || [];

    // Combine existing callback URL's with the ones we calculated
    const RedirectUrisSignIn = [...redirectDomains.map(domain => `https://${domain}${redirectPathSignIn}`), ...existingRedirectUrisSignIn];
    const RedirectUrisSignOut = [...redirectDomains.map(domain => `https://${domain}${redirectPathSignOut}`), ...existingRedirectUrisSignOut];

    // Deduplicate entries
    let RedirectUrisSignInDeduplicated = [...new Set(RedirectUrisSignIn)];
    let RedirectUrisSignOutDeduplicated = [...new Set(RedirectUrisSignOut)];

    // Determine which URL's we are going to add––and weren't already there
    const AddedRedirectUrisSignIn = RedirectUrisSignInDeduplicated.filter(url => !existingRedirectUrisSignIn.includes(url));
    const AddedRedirectUrisSignOut = RedirectUrisSignOutDeduplicated.filter(url => !existingRedirectUrisSignOut.includes(url));

    if (action === 'Delete') {
        // Upon deletes, remove the callback URL's we added ourselves earlier
        const decoded = decodePhysicalResourceId(physicalResourceId);
        if (decoded) {
            RedirectUrisSignInDeduplicated = RedirectUrisSignInDeduplicated.filter(url => decoded.AddedRedirectUrisSignIn.includes(url));
            RedirectUrisSignOutDeduplicated = RedirectUrisSignInDeduplicated.filter(url => decoded.AddedRedirectUrisSignIn.includes(url));
        } else {
            console.log(`Can't decode PhysicalResourceId ${physicalResourceId}––keeping existing redirect URI's`);
        }
    }

    // And finally, update the user pool client
    const input: CognitoIdentityServiceProvider.Types.UpdateUserPoolClientRequest = {
        AllowedOAuthFlows: UserPoolClient?.AllowedOAuthFlows || ['code'],
        AllowedOAuthFlowsUserPoolClient: UserPoolClient?.AllowedOAuthFlowsUserPoolClient || true,
        SupportedIdentityProviders: UserPoolClient?.SupportedIdentityProviders || ['COGNITO'],
        AllowedOAuthScopes: UserPoolClient?.AllowedOAuthScopes || JSON.parse(oAuthScopes),
        ClientId: clientId,
        UserPoolId: userPoolId,
        AnalyticsConfiguration: UserPoolClient?.AnalyticsConfiguration,
        ClientName: UserPoolClient?.ClientName,
        DefaultRedirectURI: UserPoolClient?.DefaultRedirectURI,
        ExplicitAuthFlows: UserPoolClient?.ExplicitAuthFlows,
        PreventUserExistenceErrors: UserPoolClient?.PreventUserExistenceErrors,
        ReadAttributes: UserPoolClient?.ReadAttributes,
        RefreshTokenValidity: UserPoolClient?.RefreshTokenValidity,
        WriteAttributes: UserPoolClient?.WriteAttributes,
        CallbackURLs: RedirectUrisSignInDeduplicated.length ? RedirectUrisSignInDeduplicated : undefined,
        LogoutURLs: RedirectUrisSignOutDeduplicated.length ? RedirectUrisSignOutDeduplicated : undefined,
    };
    await cognitoClient.updateUserPoolClient(input).promise();
    return {
        physicalResourceId: encodePhysicalResourceId({
            AddedRedirectUrisSignIn, AddedRedirectUrisSignOut
        }),
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

interface CreatedPhysicalResourceId {
    AddedRedirectUrisSignIn: string[];
    AddedRedirectUrisSignOut: string[];
}

function encodePhysicalResourceId(obj: CreatedPhysicalResourceId) {
    return JSON.stringify({
        AddedRedirectUrisSignIn: obj.AddedRedirectUrisSignIn.sort(),
        AddedRedirectUrisSignOut: obj.AddedRedirectUrisSignOut.sort(),
    });
}

function decodePhysicalResourceId(physicalResourceId?: string) {
    try {
        return JSON.parse(physicalResourceId!) as CreatedPhysicalResourceId
    } catch (err) {
        console.error(`Can't parse physicalResourceId: ${physicalResourceId}`);
    }
}

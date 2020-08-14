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


async function getUserPoolClient(props: Props) {
    const userPoolId = props.UserPoolArn.split('/')[1];
    const userPoolRegion = props.UserPoolArn.split(':')[3];
    const cognitoClient = new CognitoIdentityServiceProvider({ region: userPoolRegion });
    const input = {
        ClientId: props.ClientId, UserPoolId: userPoolId
    };
    console.debug(JSON.stringify(input, null, 4));
    const { UserPoolClient } = await cognitoClient.describeUserPoolClient(input).promise();
    return UserPoolClient;
}

async function updateUserPoolClient(props: Props, redirectUrisSignIn: string[], redirectUrisSignOut: string[], existingUserPoolClient?: CognitoIdentityServiceProvider.UserPoolClientType) {
    const userPoolId = props.UserPoolArn.split('/')[1];
    const userPoolRegion = props.UserPoolArn.split(':')[3];
    const cognitoClient = new CognitoIdentityServiceProvider({ region: userPoolRegion });

    let AllowedOAuthFlows = [...new Set(['code', ...existingUserPoolClient?.AllowedOAuthFlows || []])];
    let AllowedOAuthFlowsUserPoolClient = true;
    let AllowedOAuthScopes = [...new Set([...props.OAuthScopes, ...existingUserPoolClient?.AllowedOAuthScopes || []])];
    let SupportedIdentityProviders = [...new Set(['COGNITO', ...existingUserPoolClient?.SupportedIdentityProviders || []])];

    // If there's no redirect URI's -- switch off OAuth (to avoid a Cognito exception)
    if (!redirectUrisSignIn.length) {
        AllowedOAuthFlows = [];
        AllowedOAuthFlowsUserPoolClient = false;
        AllowedOAuthScopes = [];
    }

    const input: CognitoIdentityServiceProvider.Types.UpdateUserPoolClientRequest = {
        AllowedOAuthFlows,
        AllowedOAuthFlowsUserPoolClient,
        AllowedOAuthScopes,
        SupportedIdentityProviders: SupportedIdentityProviders,
        ClientId: props.ClientId,
        UserPoolId: userPoolId,
        CallbackURLs: [...new Set(redirectUrisSignIn)],
        LogoutURLs: [...new Set(redirectUrisSignOut)],
    };
    console.debug(JSON.stringify(input, null, 4));
    await cognitoClient.updateUserPoolClient(input).promise();
}


async function undoPriorUpdate(props: Props, redirectUrisSignInToRemove: string[], redirectUrisSignOutToRemove: string[]) {

    // Get existing callback URL's
    const existingUserPoolClient = await getUserPoolClient(props);
    if (!existingUserPoolClient) {
        return;
    }
    const existingRedirectUrisSignIn = existingUserPoolClient.CallbackURLs || [];
    const existingRedirectUrisSignOut = existingUserPoolClient.LogoutURLs || [];

    // Remove the callback URL's we added to the list earlier
    const redirectUrisSignInToKeep = existingRedirectUrisSignIn.filter(uri => !redirectUrisSignInToRemove.includes(uri));
    const redirectUrisSignOutToKeep = existingRedirectUrisSignOut.filter(uri => !redirectUrisSignOutToRemove.includes(uri));

    await updateUserPoolClient(props, redirectUrisSignInToKeep, redirectUrisSignOutToKeep, existingUserPoolClient);
}

async function doNewUpdate(props: Props, redirectUrisSignIn: string[], redirectUrisSignOut: string[]) {
    // Get existing callback URL's
    const existingUserPoolClient = await getUserPoolClient(props);
    const existingRedirectUrisSignIn = existingUserPoolClient?.CallbackURLs || [];
    const existingRedirectUrisSignOut = existingUserPoolClient?.LogoutURLs || [];

    if (redirectUrisSignIn.find(uri => existingRedirectUrisSignIn.includes(uri))) {
        throw new Error("SignIn URI's overlap with pre-existing SignIn URI's on User Pool Client. Cannot continue without becoming mixed up.");
    }
    if (redirectUrisSignOut.find(uri => existingRedirectUrisSignOut.includes(uri))) {
        throw new Error("SignOut URI's overlap with pre-existing SignOut URI's on User Pool Client. Cannot continue without becoming mixed up.");
    }

    // Add new callback url's
    const redirectUrisSignInToSet = [...existingRedirectUrisSignIn, ...redirectUrisSignIn];
    const redirectUrisSignOutToSet = [...existingRedirectUrisSignOut, ...redirectUrisSignOut];
    await updateUserPoolClient(props, redirectUrisSignInToSet, redirectUrisSignOutToSet, existingUserPoolClient);
}

interface Props {
    UserPoolArn: string;
    ClientId: string;
    OAuthScopes: string[];
    CloudFrontDistributionDomainName: string;
    RedirectPathSignIn: string;
    RedirectPathSignOut: string;
    AlternateDomainNames: string[];
}


function getRedirectUris(props: Props) {
    const redirectDomains = [props.CloudFrontDistributionDomainName, ...props.AlternateDomainNames].filter(domain => !!domain);
    const redirectUrisSignIn = redirectDomains.map(domain => `https://${domain}${props.RedirectPathSignIn}`);
    const redirectUrisSignOut = redirectDomains.map(domain => `https://${domain}${props.RedirectPathSignOut}`);
    return { redirectUrisSignIn, redirectUrisSignOut }
}

async function updateCognitoUserPoolClient(
    requestType: 'Create' | 'Update' | 'Delete', currentProps: Props, oldProps?: Props, physicalResourceId?: string
) {
    const currentUris = getRedirectUris(currentProps);
    if (requestType === 'Create') {
        await doNewUpdate(currentProps, currentUris.redirectUrisSignIn, currentUris.redirectUrisSignOut);
    } else if (requestType === 'Update') {
        const priorUris = getRedirectUris(oldProps!);
        await undoPriorUpdate(oldProps!, priorUris.redirectUrisSignIn, priorUris.redirectUrisSignOut);
        await doNewUpdate(currentProps, currentUris.redirectUrisSignIn, currentUris.redirectUrisSignOut);
    } else if (requestType === 'Delete' && physicalResourceId === 'UpdatedUserPoolClient') {
        await undoPriorUpdate(currentProps, currentUris.redirectUrisSignIn, currentUris.redirectUrisSignOut);
    }

    return {
        RedirectUrisSignIn: currentUris.redirectUrisSignIn.join(','),
        RedirectUrisSignOut: currentUris.redirectUrisSignOut.join(','),
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
    const { OldResourceProperties } = event as CloudFormationCustomResourceUpdateEvent;

    let response: CloudFormationCustomResourceResponse;
    try {
        const Data = await updateCognitoUserPoolClient(RequestType, ResourceProperties as unknown as Props, OldResourceProperties as unknown as Props, PhysicalResourceId);
        response = {
            LogicalResourceId,
            PhysicalResourceId: "UpdatedUserPoolClient",
            Status: 'SUCCESS',
            RequestId,
            StackId,
            Data,
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

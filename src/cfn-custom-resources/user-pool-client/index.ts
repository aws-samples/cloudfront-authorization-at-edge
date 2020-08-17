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

const CUSTOM_RESOURCE_CURRENT_VERSION_NAME = "UpdatedUserPoolClientV2";


async function getUserPoolClient(props: Props) {
    const userPoolId = props.UserPoolArn.split('/')[1];
    const userPoolRegion = props.UserPoolArn.split(':')[3];
    const cognitoClient = new CognitoIdentityServiceProvider({ region: userPoolRegion });
    const input = {
        ClientId: props.UserPoolClientId, UserPoolId: userPoolId
    };
    console.debug("Describing User Pool Client", JSON.stringify(input, null, 4));
    const { UserPoolClient } = await cognitoClient.describeUserPoolClient(input).promise();
    return UserPoolClient;
}

async function updateUserPoolClient(props: Props, redirectUrisSignIn: string[], redirectUrisSignOut: string[], existingUserPoolClient?: CognitoIdentityServiceProvider.UserPoolClientType) {
    const userPoolId = props.UserPoolArn.split('/')[1];
    const userPoolRegion = props.UserPoolArn.split(':')[3];
    const cognitoClient = new CognitoIdentityServiceProvider({ region: userPoolRegion });

    // Merge OAuth scopes and flows with what is already there on the existing User Pool Client
    let AllowedOAuthFlows = [...new Set(['code'].concat(existingUserPoolClient?.AllowedOAuthFlows || []))];
    let AllowedOAuthFlowsUserPoolClient = true;
    let AllowedOAuthScopes = [...new Set(props.OAuthScopes.concat(existingUserPoolClient?.AllowedOAuthScopes || []))];

    let SupportedIdentityProviders = existingUserPoolClient?.SupportedIdentityProviders || [];
    if (props.CreateUserPoolAndClient === "true") {
        // If we were the ones creating the User Pool Client, we'll enable COGNITO as IDP (probably the user wants this, if only for initial testing)
        SupportedIdentityProviders = ['COGNITO'];
    }

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
        ClientId: props.UserPoolClientId,
        UserPoolId: userPoolId,
        CallbackURLs: [...new Set(redirectUrisSignIn)],
        LogoutURLs: [...new Set(redirectUrisSignOut)],
    };
    console.debug("Updating User Pool Client", JSON.stringify(input, null, 4));
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

    // Add new callback url's
    const redirectUrisSignInToSet = [...existingRedirectUrisSignIn, ...redirectUrisSignIn];
    const redirectUrisSignOutToSet = [...existingRedirectUrisSignOut, ...redirectUrisSignOut];
    await updateUserPoolClient(props, redirectUrisSignInToSet, redirectUrisSignOutToSet, existingUserPoolClient);
}

interface Props {
    UserPoolArn: string;
    UserPoolClientId: string;
    OAuthScopes: string[];
    CloudFrontDistributionDomainName: string;
    RedirectPathSignIn: string;
    RedirectPathSignOut: string;
    AlternateDomainNames: string[];
    CreateUserPoolAndClient: "true" | "false";
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
        if (physicalResourceId === CUSTOM_RESOURCE_CURRENT_VERSION_NAME) {
            const priorUris = getRedirectUris(oldProps!);
            await undoPriorUpdate(oldProps!, priorUris.redirectUrisSignIn, priorUris.redirectUrisSignOut);
        }
        await doNewUpdate(currentProps, currentUris.redirectUrisSignIn, currentUris.redirectUrisSignOut);
    } else if (requestType === 'Delete') {
        if (physicalResourceId === CUSTOM_RESOURCE_CURRENT_VERSION_NAME) {
            await undoPriorUpdate(currentProps, currentUris.redirectUrisSignIn, currentUris.redirectUrisSignOut);
        }
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
            PhysicalResourceId: CUSTOM_RESOURCE_CURRENT_VERSION_NAME,
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

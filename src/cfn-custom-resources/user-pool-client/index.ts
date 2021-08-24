/*
    Copyright 2021 Amazon.com, Inc. or its affiliates. All Rights Reserved.
    SPDX-License-Identifier: MIT-0

    This is a CloudFormation custom resource. It's purpose is to:

    - Update a User Pool Client's redirect URL's

    We need to do this in a custom resource, to support the scenario of updating a pre-existing User Pool Client
*/

import {
  CloudFormationCustomResourceHandler,
  CloudFormationCustomResourceDeleteEvent,
  CloudFormationCustomResourceUpdateEvent,
} from "aws-lambda";
import CognitoIdentityServiceProvider from "aws-sdk/clients/cognitoidentityserviceprovider";
import { sendCfnResponse, Status } from "./cfn-response";

const CUSTOM_RESOURCE_CURRENT_VERSION_NAME = "UpdatedUserPoolClientV2";
const SENTINEL_DOMAIN = "example.com";

async function getUserPoolClient(props: Props) {
  const userPoolId = props.UserPoolArn.split("/")[1];
  const userPoolRegion = props.UserPoolArn.split(":")[3];
  const cognitoClient = new CognitoIdentityServiceProvider({
    region: userPoolRegion,
  });
  const input = {
    ClientId: props.UserPoolClientId,
    UserPoolId: userPoolId,
  };
  console.debug("Describing User Pool Client", JSON.stringify(input, null, 4));
  const { UserPoolClient } = await cognitoClient
    .describeUserPoolClient(input)
    .promise();
  if (!UserPoolClient) {
    throw new Error("User Pool Client not found!");
  }
  return UserPoolClient;
}

async function updateUserPoolClient(
  props: Props,
  redirectUrisSignIn: string[],
  redirectUrisSignOut: string[],
  existingUserPoolClient: CognitoIdentityServiceProvider.UserPoolClientType
) {
  const userPoolId = props.UserPoolArn.split("/")[1];
  const userPoolRegion = props.UserPoolArn.split(":")[3];
  const cognitoClient = new CognitoIdentityServiceProvider({
    region: userPoolRegion,
  });

  // To be able to set the redirect URL's, we must enable OAuth––required by Cognito
  // Vice versa, when removing redirect URL's, we must disable OAuth if there's no more redirect URL's left

  // Merge OAuth scopes and flows with what is already there on the existing User Pool Client
  let AllowedOAuthFlows = ["code"];
  let AllowedOAuthFlowsUserPoolClient = true;
  let AllowedOAuthScopes = props.OAuthScopes;

  const CallbackURLs = [...new Set(redirectUrisSignIn)].filter(
    (uri) => new URL(uri).hostname !== SENTINEL_DOMAIN
  );
  const LogoutURLs = [...new Set(redirectUrisSignOut)].filter(
    (uri) => new URL(uri).hostname !== SENTINEL_DOMAIN
  );

  // If there's no redirect URI's -- switch off OAuth (to avoid a Cognito exception)
  if (!CallbackURLs.length) {
    AllowedOAuthFlows = [];
    AllowedOAuthFlowsUserPoolClient = false;
    AllowedOAuthScopes = [];
  }

  const input: CognitoIdentityServiceProvider.Types.UpdateUserPoolClientRequest =
    {
      AllowedOAuthFlows,
      AllowedOAuthFlowsUserPoolClient,
      AllowedOAuthScopes,
      ClientId: props.UserPoolClientId,
      UserPoolId: userPoolId,
      CallbackURLs,
      LogoutURLs,
      SupportedIdentityProviders:
        existingUserPoolClient.SupportedIdentityProviders, // Need to provide existing values otherwise they get cleared out :|
    };
  console.debug("Updating User Pool Client", JSON.stringify(input, null, 4));
  await cognitoClient.updateUserPoolClient(input).promise();
}

async function undoPriorUpdate(
  props: Props,
  redirectUrisSignInToRemove: string[],
  redirectUrisSignOutToRemove: string[]
) {
  // Get existing callback URL's
  const existingUserPoolClient = await getUserPoolClient(props);
  const existingRedirectUrisSignIn = existingUserPoolClient.CallbackURLs || [];
  const existingRedirectUrisSignOut = existingUserPoolClient.LogoutURLs || [];

  // Remove the callback URL's we added to the list earlier
  const redirectUrisSignInToKeep = existingRedirectUrisSignIn.filter(
    (uri) => !redirectUrisSignInToRemove.includes(uri)
  );
  const redirectUrisSignOutToKeep = existingRedirectUrisSignOut.filter(
    (uri) => !redirectUrisSignOutToRemove.includes(uri)
  );

  await updateUserPoolClient(
    props,
    redirectUrisSignInToKeep,
    redirectUrisSignOutToKeep,
    existingUserPoolClient
  );
}

async function doNewUpdate(
  props: Props,
  redirectUrisSignIn: string[],
  redirectUrisSignOut: string[]
) {
  // Get existing callback URL's
  const existingUserPoolClient = await getUserPoolClient(props);
  const existingRedirectUrisSignIn = existingUserPoolClient?.CallbackURLs || [];
  const existingRedirectUrisSignOut = existingUserPoolClient?.LogoutURLs || [];

  // Add new callback url's
  const redirectUrisSignInToSet = [
    ...existingRedirectUrisSignIn,
    ...redirectUrisSignIn,
  ];
  const redirectUrisSignOutToSet = [
    ...existingRedirectUrisSignOut,
    ...redirectUrisSignOut,
  ];
  await updateUserPoolClient(
    props,
    redirectUrisSignInToSet,
    redirectUrisSignOutToSet,
    existingUserPoolClient
  );
}

interface Props {
  UserPoolArn: string;
  UserPoolClientId: string;
  OAuthScopes: string[];
  CloudFrontDistributionDomainName: string;
  RedirectPathSignIn: string;
  RedirectPathSignOut: string;
  AlternateDomainNames: string[];
}

function getRedirectUris(props: Props) {
  const redirectDomains = [
    props.CloudFrontDistributionDomainName,
    ...props.AlternateDomainNames,
  ].filter((domain) => !!domain);
  const redirectUrisSignIn = redirectDomains.map(
    (domain) => `https://${domain}${props.RedirectPathSignIn}`
  );
  const redirectUrisSignOut = redirectDomains.map(
    (domain) => `https://${domain}${props.RedirectPathSignOut}`
  );
  return { redirectUrisSignIn, redirectUrisSignOut };
}

async function updateCognitoUserPoolClient(
  requestType: "Create" | "Update" | "Delete",
  currentProps: Props,
  oldProps?: Props,
  physicalResourceId?: string
) {
  const currentUris = getRedirectUris(currentProps);
  if (requestType === "Create") {
    await doNewUpdate(
      currentProps,
      currentUris.redirectUrisSignIn,
      currentUris.redirectUrisSignOut
    );
  } else if (requestType === "Update") {
    if (physicalResourceId === CUSTOM_RESOURCE_CURRENT_VERSION_NAME) {
      const priorUris = getRedirectUris(oldProps!);
      await undoPriorUpdate(
        oldProps!,
        priorUris.redirectUrisSignIn,
        priorUris.redirectUrisSignOut
      );
    }
    await doNewUpdate(
      currentProps,
      currentUris.redirectUrisSignIn,
      currentUris.redirectUrisSignOut
    );
  } else if (requestType === "Delete") {
    if (physicalResourceId === CUSTOM_RESOURCE_CURRENT_VERSION_NAME) {
      await undoPriorUpdate(
        currentProps,
        currentUris.redirectUrisSignIn,
        currentUris.redirectUrisSignOut
      );
    }
  }

  return {
    RedirectUrisSignIn: currentUris.redirectUrisSignIn.join(","),
    RedirectUrisSignOut: currentUris.redirectUrisSignOut.join(","),
  };
}

export const handler: CloudFormationCustomResourceHandler = async (event) => {
  console.log(JSON.stringify(event, undefined, 4));
  const { ResourceProperties, RequestType } = event;

  const { PhysicalResourceId } = event as
    | CloudFormationCustomResourceDeleteEvent
    | CloudFormationCustomResourceUpdateEvent;
  const { OldResourceProperties } =
    event as CloudFormationCustomResourceUpdateEvent;

  let status = Status.SUCCESS;
  let physicalResourceId: string | undefined;
  let data: { [key: string]: any } | undefined;
  let reason: string | undefined;
  try {
    data = await updateCognitoUserPoolClient(
      RequestType,
      ResourceProperties as unknown as Props,
      OldResourceProperties as unknown as Props,
      PhysicalResourceId
    );
  } catch (err) {
    console.error(err);
    status = Status.FAILED;
    reason = err;
  }
  await sendCfnResponse({
    event,
    status,
    data,
    physicalResourceId,
    reason,
  });
};

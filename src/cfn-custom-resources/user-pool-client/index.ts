/*
    Copyright 2021 Amazon.com, Inc. or its affiliates. All Rights Reserved.
    SPDX-License-Identifier: MIT-0

    This is a CloudFormation custom resource. It's purpose is to:

    - Update a User Pool Client's redirect URL's

    We need to do this in a custom resource, to support the scenario of updating a pre-existing User Pool Client
*/

import {
  CloudFormationCustomResourceHandler,
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

  const CallbackURLs = [...new Set(redirectUrisSignIn)].filter(
    (uri) => new URL(uri).hostname !== SENTINEL_DOMAIN
  );
  const LogoutURLs = [...new Set(redirectUrisSignOut)].filter(
    (uri) => new URL(uri).hostname !== SENTINEL_DOMAIN
  );

  // To be able to set the redirect URL's, we must enable OAuth––required by Cognito
  // Vice versa, when removing redirect URL's, we must disable OAuth if there's no more redirect URL's left
  let AllowedOAuthFlows: string[];
  let AllowedOAuthFlowsUserPoolClient: boolean;
  let AllowedOAuthScopes: string[];
  if (CallbackURLs.length) {
    AllowedOAuthFlows = ["code"];
    AllowedOAuthFlowsUserPoolClient = true;
    AllowedOAuthScopes = props.OAuthScopes;
  } else {
    AllowedOAuthFlows = [];
    AllowedOAuthFlowsUserPoolClient = false;
    AllowedOAuthScopes = [];
  }

  // Provide existing fields as well (excluding properties not valid for Update operations), experience teaches this prevents errors when calling the Cognito API
  // https://github.com/aws-samples/cloudfront-authorization-at-edge/issues/144
  // https://github.com/aws-samples/cloudfront-authorization-at-edge/issues/172
  const existingFields = { ...existingUserPoolClient };
  delete existingFields.CreationDate;
  delete existingFields.LastModifiedDate;
  delete existingFields.ClientSecret;

  const input: CognitoIdentityServiceProvider.Types.UpdateUserPoolClientRequest =
    {
      ...existingFields,
      AllowedOAuthFlows,
      AllowedOAuthFlowsUserPoolClient,
      AllowedOAuthScopes,
      ClientId: props.UserPoolClientId,
      UserPoolId: userPoolId,
      CallbackURLs,
      LogoutURLs,
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
  const { OldResourceProperties } =
    event as CloudFormationCustomResourceUpdateEvent;

  let physicalResourceId: string;
  if (event.RequestType === "Create") {
    physicalResourceId = CUSTOM_RESOURCE_CURRENT_VERSION_NAME;
  } else {
    physicalResourceId = event.PhysicalResourceId;
  }

  let status = Status.SUCCESS;
  let data: { [key: string]: any } | undefined;
  let reason: string | undefined;
  try {
    data = await updateCognitoUserPoolClient(
      RequestType,
      ResourceProperties as unknown as Props,
      OldResourceProperties as unknown as Props,
      physicalResourceId
    );
  } catch (err) {
    console.error(err);
    status = Status.FAILED;
    reason = `${err}`;
  }
  await sendCfnResponse({
    event,
    status,
    data,
    physicalResourceId,
    reason,
  });
};

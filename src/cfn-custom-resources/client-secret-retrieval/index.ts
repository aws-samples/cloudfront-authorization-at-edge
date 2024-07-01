// Copyright 2021 Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { CloudFormationCustomResourceHandler } from "aws-lambda";
import { CognitoIdentityProvider, DescribeUserPoolClientCommandInput } from "@aws-sdk/client-cognito-identity-provider";
import { sendCfnResponse, Status } from "./cfn-response";

async function retrieveClientSecret(
  action: "Create" | "Update" | "Delete",
  userPoolArn: string,
  clientId: string,
  physicalResourceId?: string
) {
  if (action === "Delete") {
    // Deletes aren't executed; the standard Resource should just be deleted
    return { physicalResourceId: physicalResourceId };
  }
  const userPoolId = userPoolArn.split("/")[1];
  const userPoolRegion = userPoolArn.split(":")[3];
  const cognitoClient = new CognitoIdentityProvider({
    region: userPoolRegion,
  });
  const input: DescribeUserPoolClientCommandInput =
    {
      UserPoolId: userPoolId,
      ClientId: clientId,
    };
  const { UserPoolClient } = await cognitoClient
    .describeUserPoolClient(input);
  if (!UserPoolClient?.ClientSecret) {
    throw new Error(
      `User Pool client ${clientId} is not set up with a client secret`
    );
  }
  return {
    physicalResourceId: `${userPoolId}-${clientId}-retrieved-client-secret`,
    Data: { ClientSecret: UserPoolClient.ClientSecret },
  };
}

export const handler: CloudFormationCustomResourceHandler = async (event) => {
  console.log(JSON.stringify(event, undefined, 4));
  const { ResourceProperties, RequestType } = event;

  const { UserPoolArn, UserPoolClientId } = ResourceProperties;

  let status = Status.SUCCESS;
  let physicalResourceId: string | undefined;
  let data: { [key: string]: any } | undefined;
  let reason: string | undefined;
  try {
    ({ physicalResourceId, Data: data } = await retrieveClientSecret(
      RequestType,
      UserPoolArn,
      UserPoolClientId
    ));
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

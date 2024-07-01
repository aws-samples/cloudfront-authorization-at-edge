/*
    Copyright 2021 Amazon.com, Inc. or its affiliates. All Rights Reserved.
    SPDX-License-Identifier: MIT-0

    This is a CloudFormation custom resource. It's purpose is to:

    - Lookup the URL of an existing User Pool Domain

    We need to do this in a custom resource to support the scenario of looking up a pre-existing User Pool Domain
*/

import {
  CloudFormationCustomResourceHandler,
  CloudFormationCustomResourceDeleteEvent,
  CloudFormationCustomResourceUpdateEvent,
} from "aws-lambda";
import { CognitoIdentityProvider } from "@aws-sdk/client-cognito-identity-provider";
import { sendCfnResponse, Status } from "./cfn-response";

async function ensureCognitoUserPoolDomain(
  action: "Create" | "Update" | "Delete",
  newUserPoolArn: string,
  physicalResourceId?: string
) {
  if (action === "Delete") {
    return physicalResourceId!;
  }
  const newUserPoolId = newUserPoolArn.split("/")[1];
  const newUserPoolRegion = newUserPoolArn.split(":")[3];
  const cognitoClient = new CognitoIdentityProvider({
    region: newUserPoolRegion,
  });
  const { UserPool } = await cognitoClient
    .describeUserPool({ UserPoolId: newUserPoolId });
  if (!UserPool) {
    throw new Error(`User Pool ${newUserPoolArn} does not exist`);
  }
  if (UserPool.CustomDomain) {
    return UserPool.CustomDomain;
  } else if (UserPool.Domain) {
    return `${UserPool.Domain}.auth.${newUserPoolRegion}.amazoncognito.com`;
  } else {
    throw new Error(
      `User Pool ${newUserPoolArn} does not have a domain set up yet`
    );
  }
}

export const handler: CloudFormationCustomResourceHandler = async (event) => {
  console.log(JSON.stringify(event, undefined, 4));
  const { ResourceProperties, RequestType } = event;

  const { PhysicalResourceId } = event as
    | CloudFormationCustomResourceDeleteEvent
    | CloudFormationCustomResourceUpdateEvent;
  let status = Status.SUCCESS;
  let physicalResourceId: string | undefined;
  let data: { [key: string]: any } | undefined;
  let reason: string | undefined;
  try {
    physicalResourceId = await ensureCognitoUserPoolDomain(
      RequestType,
      ResourceProperties.UserPoolArn,
      PhysicalResourceId
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

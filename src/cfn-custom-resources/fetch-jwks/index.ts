// Copyright 2022 Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import {
  CloudFormationCustomResourceHandler,
  CloudFormationCustomResourceDeleteEvent,
  CloudFormationCustomResourceUpdateEvent,
} from "aws-lambda";
import { sendCfnResponse, Status } from "./cfn-response";
import { fetch } from "./https";

async function fetchJwks(
  action: "Create" | "Update" | "Delete",
  userPoolArn: string,
  physicalResourceId?: string
) {
  if (action === "Delete") {
    // Deletes aren't executed
    return { physicalResourceId: physicalResourceId!, Data: {} };
  }
  console.log(`Fetching JWKS for ${userPoolArn}`);

  const match = userPoolArn.match(
    new RegExp("userpool/(?<region>.+)_(?<userPoolId>.+)$")
  );
  if (!match?.groups) {
    throw new Error("Failed to parse User Pool ARN");
  }
  const url = `https://cognito-idp.${match.groups.region}.amazonaws.com/${match.groups.region}_${match.groups.userPoolId}/.well-known/jwks.json`;

  console.log(`Fetching JWKS from ${url}`);
  const jwks = (await fetch(url)).toString();
  console.log(`Fetched JWKS: ${jwks}`);

  return {
    physicalResourceId: userPoolArn,
    Data: { Jwks: jwks },
  };
}

export const handler: CloudFormationCustomResourceHandler = async (event) => {
  const { ResourceProperties, RequestType } = event;

  const { PhysicalResourceId } = event as
    | CloudFormationCustomResourceDeleteEvent
    | CloudFormationCustomResourceUpdateEvent;

  const { UserPoolArn } = ResourceProperties;

  let status = Status.SUCCESS;
  let physicalResourceId: string | undefined;
  let data: { [key: string]: any } | undefined;
  let reason: string | undefined;
  try {
    ({ physicalResourceId, Data: data } = await fetchJwks(
      RequestType,
      UserPoolArn,
      PhysicalResourceId
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

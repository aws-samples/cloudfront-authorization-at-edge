// Copyright 2021 Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import {
  CloudFormationCustomResourceHandler,
  CloudFormationCustomResourceDeleteEvent,
  CloudFormationCustomResourceUpdateEvent,
} from "aws-lambda";
import Lambda from "aws-sdk/clients/lambda";
import Zip from "adm-zip";
import { writeFileSync, mkdtempSync } from "fs";
import { resolve } from "path";
import { sendCfnResponse, Status } from "./cfn-response";
import { fetch } from "./https";

async function updateLambdaCode(
  action: "Create" | "Update" | "Delete",
  lambdaFunction: string,
  stringifiedConfig: string,
  physicalResourceId?: string
) {
  if (action === "Delete") {
    // Deletes aren't executed; the Lambda Resource should just be deleted
    return { physicalResourceId: physicalResourceId!, Data: {} };
  }
  console.log(
    `Adding configuration to Lambda function ${lambdaFunction}:\n${stringifiedConfig}`
  );
  const region = lambdaFunction.split(":")[3];
  const lambdaClient = new Lambda({ region });
  // Parse the JSON to ensure it's validity (and avoid ugly errors at runtime)
  const config = JSON.parse(stringifiedConfig);
  // Fetch and extract Lambda zip contents to temporary folder, add configuration.json, and rezip
  const { Code } = await lambdaClient
    .getFunction({
      FunctionName: lambdaFunction,
    })
    .promise();
  const data = await fetch(Code!.Location!);
  const lambdaZip = new Zip(data);
  console.log(
    "Lambda zip contents:",
    lambdaZip.getEntries().map((entry) => entry.name)
  );
  console.log("Adding (fresh) configuration.json ...");
  const tempDir = mkdtempSync("/tmp/lambda-package");
  lambdaZip.extractAllTo(tempDir, true);
  writeFileSync(
    resolve(tempDir, "configuration.json"),
    Buffer.from(JSON.stringify(config, null, 2))
  );
  const newLambdaZip = new Zip();
  newLambdaZip.addLocalFolder(tempDir);
  console.log(
    "New Lambda zip contents:",
    newLambdaZip.getEntries().map((entry) => entry.name)
  );

  const { CodeSha256, Version, FunctionArn } = await lambdaClient
    .updateFunctionCode({
      FunctionName: lambdaFunction,
      ZipFile: newLambdaZip.toBuffer(),
      Publish: true,
    })
    .promise();
  console.log({ CodeSha256, Version, FunctionArn });
  return {
    physicalResourceId: lambdaFunction,
    Data: { CodeSha256, Version, FunctionArn },
  };
}

export const handler: CloudFormationCustomResourceHandler = async (event) => {
  const { ResourceProperties, RequestType } = event;

  const { PhysicalResourceId } = event as
    | CloudFormationCustomResourceDeleteEvent
    | CloudFormationCustomResourceUpdateEvent;

  const { LambdaFunction, Configuration } = ResourceProperties;

  let status = Status.SUCCESS;
  let physicalResourceId: string | undefined;
  let data: { [key: string]: any } | undefined;
  let reason: string | undefined;
  try {
    ({ physicalResourceId, Data: data } = await updateLambdaCode(
      RequestType,
      LambdaFunction,
      Configuration,
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

// Copyright 2021 Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import {
  CloudFormationCustomResourceHandler,
  CloudFormationCustomResourceDeleteEvent,
  CloudFormationCustomResourceUpdateEvent,
} from "aws-lambda";
import staticSiteUpload from "s3-spa-upload";
import { mkdirSync } from "fs";
import { sendCfnResponse, Status } from "./cfn-response";

interface Configuration {
  BucketName: string;
}

async function uploadPages(
  action: "Create" | "Update" | "Delete",
  config: Configuration,
  physicalResourceId?: string
) {
  if (action === "Create" || action === "Update") {
    await staticSiteUpload(`${__dirname}/pages`, config.BucketName);
  } else {
    // "Trick" to empty the bucket is to upload an empty dir
    mkdirSync("/tmp/empty_directory", { recursive: true });
    await staticSiteUpload("/tmp/empty_directory", config.BucketName, {
      delete: true,
    });
  }
  return physicalResourceId || "StaticSite";
}

export const handler: CloudFormationCustomResourceHandler = async (
  event,
  context
) => {
  console.log(JSON.stringify(event, undefined, 4));

  const { ResourceProperties, RequestType } = event;

  const { ServiceToken, ...config } = ResourceProperties;

  const { PhysicalResourceId } = event as
    | CloudFormationCustomResourceDeleteEvent
    | CloudFormationCustomResourceUpdateEvent;

  let status = Status.SUCCESS;
  let physicalResourceId: string | undefined;
  let data: { [key: string]: any } | undefined;
  let reason: string | undefined;
  try {
    physicalResourceId = await Promise.race([
      uploadPages(RequestType, config as Configuration, PhysicalResourceId),
      new Promise<undefined>((_, reject) =>
        setTimeout(
          () => reject(new Error("Task timeout")),
          context.getRemainingTimeInMillis() - 500
        )
      ),
    ]);
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

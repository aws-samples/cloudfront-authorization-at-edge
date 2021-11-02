// Copyright 2021 Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { randomBytes } from "crypto";
import {
  CloudFormationCustomResourceHandler,
  CloudFormationCustomResourceDeleteEvent,
  CloudFormationCustomResourceUpdateEvent,
} from "aws-lambda";
import { sendCfnResponse, Status } from "./cfn-response";

export const handler: CloudFormationCustomResourceHandler = async (event) => {
  console.log(JSON.stringify(event, undefined, 4));
  const { ResourceProperties } = event;

  const { PhysicalResourceId } = event as
    | CloudFormationCustomResourceDeleteEvent
    | CloudFormationCustomResourceUpdateEvent;

  const {
    Length = 16,
    AllowedCharacters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~",
  } = ResourceProperties;

  let status = Status.SUCCESS;
  let physicalResourceId: string | undefined;
  let data: { [key: string]: any } | undefined;
  let reason: string | undefined;
  try {
    physicalResourceId =
      PhysicalResourceId ||
      [...new Array(parseInt(Length))]
        .map(() => randomChoiceFromIndexable(AllowedCharacters))
        .join("");
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

function randomChoiceFromIndexable(indexable: string) {
  if (indexable.length > 256) {
    throw new Error(`indexable is too large: ${indexable.length}`);
  }
  const chunks = Math.floor(256 / indexable.length);
  const firstBiassedIndex = indexable.length * chunks;
  let randomNumber: number;
  do {
    randomNumber = randomBytes(1)[0];
  } while (randomNumber >= firstBiassedIndex);
  const index = randomNumber % indexable.length;
  return indexable[index];
}

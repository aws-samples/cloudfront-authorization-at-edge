// Copyright 2021 Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { request } from "https";

export enum Status {
  "SUCCESS" = "SUCCESS",
  "FAILED" = "FAILED",
}

export async function sendCfnResponse(props: {
  event: {
    StackId: string;
    RequestId: string;
    LogicalResourceId: string;
    ResponseURL: string;
  };
  status: Status;
  reason?: string;
  data?: {
    [key: string]: string;
  };
  physicalResourceId?: string;
}) {
  const response = {
    Status: props.status,
    Reason: props.reason?.toString() || "See CloudWatch logs",
    PhysicalResourceId: props.physicalResourceId || "no-explicit-id",
    StackId: props.event.StackId,
    RequestId: props.event.RequestId,
    LogicalResourceId: props.event.LogicalResourceId,
    Data: props.data || {},
  };

  await new Promise<void>((resolve, reject) => {
    const options = {
      method: "PUT",
      headers: { "content-type": "" },
    };
    request(props.event.ResponseURL, options)
      .on("error", (err) => {
        reject(err);
      })
      .end(JSON.stringify(response), "utf8", resolve);
  });
}

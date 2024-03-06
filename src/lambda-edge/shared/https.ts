// Copyright 2021 Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { IncomingHttpHeaders } from "http";
import { request, RequestOptions } from "https";
import { Writable, pipeline } from "stream";

const DEFAULT_REQUEST_TIMEOUT = 4000; // 4 seconds

export async function fetch(
  uri: string,
  data?: Buffer,
  options?: RequestOptions
) {
  return new Promise<{
    status?: number;
    headers: IncomingHttpHeaders;
    data: Buffer;
  }>((resolve, reject) => {
    const requestOptions = {
      // @ts-ignore
      signal: AbortSignal.timeout(DEFAULT_REQUEST_TIMEOUT),
      ...(options ?? {}),
    };

    const req = request(uri, requestOptions, (res) =>
      pipeline(
        [
          res,
          collectBuffer((data) =>
            resolve({ status: res.statusCode, headers: res.headers, data })
          ),
        ],
        done
      )
    );

    function done(error?: Error | null) {
      if (!error) return;
      req.destroy(error);
      reject(error);
    }

    req.on("error", done);

    req.end(data);
  });
}

const collectBuffer = (callback: (collectedBuffer: Buffer) => void) => {
  const chunks = [] as Buffer[];
  return new Writable({
    write: (chunk, _encoding, done) => {
      try {
        chunks.push(chunk);
        done();
      } catch (err) {
        done(err as Error);
      }
    },
    final: (done) => {
      try {
        callback(Buffer.concat(chunks));
        done();
      } catch (err) {
        done(err as Error);
      }
    },
  });
};

// Copyright 2021 Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { request } from "https";
import { Writable, pipeline } from "stream";

export async function fetch(uri: string) {
  return new Promise<Buffer>((resolve, reject) => {
    const req = request(uri, (res) =>
      pipeline([res, collectBuffer(resolve)], done)
    );

    function done(error?: Error | null) {
      if (!error) return;
      req.destroy(error);
      reject(error);
    }

    req.on("error", done);

    req.end();
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

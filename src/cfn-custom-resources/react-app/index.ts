// Copyright 2021 Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { execSync } from "child_process";
import {
  CloudFormationCustomResourceHandler,
  CloudFormationCustomResourceDeleteEvent,
  CloudFormationCustomResourceUpdateEvent,
} from "aws-lambda";
import s3SpaUpload from "s3-spa-upload";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { ncp } from "ncp";
import { sendCfnResponse, Status } from "./cfn-response";

interface Configuration {
  BucketName: string;
  ClientId: string;
  CognitoAuthDomain: string;
  RedirectPathSignIn: string;
  RedirectPathSignOut: string;
  UserPoolArn: string;
  OAuthScopes: string;
  SignOutUrl: string;
  CookieSettings: string;
}

async function buildSpa(config: Configuration) {
  const temp_dir = "/tmp/spa";
  const home_dir = "/tmp/home";

  console.log(
    `Copying SPA sources to ${temp_dir} and making dependencies available there ...`
  );

  [temp_dir, home_dir].forEach((dir) => {
    if (!existsSync(dir)) {
      mkdirSync(dir);
    }
  });

  await Promise.all(
    ["src", "public", "package.json", "package-lock.json"].map(
      async (path) =>
        new Promise<void>((resolve, reject) => {
          ncp(`${__dirname}/react-app/${path}`, `${temp_dir}/${path}`, (err) =>
            err ? reject(err) : resolve()
          );
        })
    )
  );

  const userPoolId = config.UserPoolArn.split("/")[1];
  const userPoolRegion = config.UserPoolArn.split(":")[3];
  const cookieSettings = JSON.parse(config.CookieSettings).idToken as
    | string
    | null;
  let cookieDomain = cookieSettings
    ?.split(";")
    .map((part) => {
      const match = part.match(/domain(\s*)=(\s*)(?<domain>.+)/i);
      return match?.groups?.domain;
    })
    .find((domain) => !!domain);
  if (!cookieDomain) {
    // Cookies without a domain, are called host-only cookies, and are perfectly normal.
    // However, AmplifyJS requires to be passed a value for domain, when using cookie storage.
    // We'll use " " as a trick to satisfy this check by AmplifyJS, and support host-only cookies.
    //
    // Note that you do not want to add an exact domain name to a cookie, if you want to have a host-only cookie,
    // because a cookie that's explicitly set for e.g. example.com is also readable by subdomain.example.com.
    // (In a cookie domain, example.com is treated the same as .example.com)
    // The ONLY way to get a host-only cookie, is by NOT including the domain attribute for the cookie at all.
    //
    // Note that if the cookie storage used in Amplify specifies a domain, this must match 1:1 the domain that
    // is used for the cookie by Auth@Edge, otherwise Amplify will have trouble setting that cookie
    // (and then e.g. signing out via Amplify no longer works, as that sets the cookies to expire them)
    cookieDomain = " ";
  }
  const reactEnv = `SKIP_PREFLIGHT_CHECK=true
  REACT_APP_USER_POOL_ID=${userPoolId}
  REACT_APP_USER_POOL_REGION=${userPoolRegion}
  REACT_APP_USER_POOL_WEB_CLIENT_ID=${config.ClientId}
  REACT_APP_USER_POOL_AUTH_DOMAIN=${config.CognitoAuthDomain}
  REACT_APP_USER_POOL_REDIRECT_PATH_SIGN_IN=${config.RedirectPathSignIn}
  REACT_APP_USER_POOL_REDIRECT_PATH_SIGN_OUT=${config.RedirectPathSignOut}
  REACT_APP_SIGN_OUT_URL=${config.SignOutUrl}
  REACT_APP_USER_POOL_SCOPES=${config.OAuthScopes}
  REACT_APP_COOKIE_DOMAIN="${cookieDomain}"
  INLINE_RUNTIME_CHUNK=false
  `;
  console.log("React env:\n", reactEnv);

  console.log(`Creating React environment file ${temp_dir}/.env ...`);
  writeFileSync(`${temp_dir}/.env`, reactEnv);

  console.log("NPM version:");
  execSync("npm -v", {
    cwd: temp_dir,
    stdio: "inherit",
    env: { ...process.env, HOME: home_dir },
  });
  console.log(`Installing dependencies to build React app in ${temp_dir} ...`);
  // Force use of NPM v8 to escape from https://github.com/npm/cli/issues/4783
  execSync("npx -p npm@8 npm ci", {
    cwd: temp_dir,
    stdio: "inherit",
    env: { ...process.env, HOME: home_dir },
  });
  console.log(`Running build of React app in ${temp_dir} ...`);
  // Force use of NPM v8 to escape from https://github.com/npm/cli/issues/4783
  execSync("npx -p npm@8 npm run build", {
    cwd: temp_dir,
    stdio: "inherit",
    env: { ...process.env, HOME: home_dir },
  });
  console.log("Build succeeded");

  return `${temp_dir}/build`;
}

async function buildUploadSpa(
  action: "Create" | "Update" | "Delete",
  config: Configuration,
  physicalResourceId?: string
) {
  if (action === "Create" || action === "Update") {
    const buildDir = await buildSpa(config);
    await s3SpaUpload(buildDir, config.BucketName);
  } else {
    // "Trick" to empty the bucket is to upload an empty dir
    mkdirSync("/tmp/empty_directory", { recursive: true });
    await s3SpaUpload("/tmp/empty_directory", config.BucketName, {
      delete: true,
    });
  }
  return physicalResourceId || "ReactApp";
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
      buildUploadSpa(RequestType, config as Configuration, PhysicalResourceId),
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

// Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { execSync } from 'child_process';
import {
    CloudFormationCustomResourceHandler,
    CloudFormationCustomResourceResponse,
    CloudFormationCustomResourceDeleteEvent,
    CloudFormationCustomResourceUpdateEvent
} from 'aws-lambda';
import axios from 'axios';
import s3SpaUpload from 's3-spa-upload';
import { symlinkSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { ncp } from 'ncp';


interface Configuration {
    BucketName: string;
    ClientId: string;
    CognitoAuthDomain: string;
    RedirectPathSignIn: string;
    RedirectPathSignOut: string;
    UserPoolId: string;
    OAuthScopes: string;
    SignOutUrl: string;
}


async function buildSpa(config: Configuration) {

    const temp_dir = '/tmp/spa';

    console.log(`Copying SPA sources to ${temp_dir} and making dependencies available there ...`);

    if (!existsSync(temp_dir)) {
        mkdirSync(temp_dir);
    }

    await Promise.all(['src', 'public', 'package.json'].map(async (path) => (
        new Promise((resolve, reject) => {
            ncp(`${__dirname}/${path}`, `${temp_dir}/${path}`, err => err ? reject(err) : resolve());
        }))
    ));
    if (!existsSync(`${temp_dir}/node_modules`)) {
        symlinkSync(`${__dirname}/node_modules`, `${temp_dir}/node_modules`);
    }

    console.log(`Creating environment file ${temp_dir}/.env ...`);
    writeFileSync(`${temp_dir}/.env`, `SKIP_PREFLIGHT_CHECK=true
REACT_APP_USER_POOL_ID=${config.UserPoolId}
REACT_APP_USER_POOL_WEB_CLIENT_ID=${config.ClientId}
REACT_APP_USER_POOL_AUTH_DOMAIN=${config.CognitoAuthDomain}
REACT_APP_USER_POOL_REDIRECT_PATH_SIGN_IN=${config.RedirectPathSignIn}
REACT_APP_USER_POOL_REDIRECT_PATH_SIGN_OUT=${config.RedirectPathSignOut}
REACT_APP_SIGN_OUT_URL=${config.SignOutUrl}
REACT_APP_USER_POOL_SCOPES=${JSON.parse(config.OAuthScopes).join(',')}
INLINE_RUNTIME_CHUNK=false
`);

    console.log(`Running build of React app in ${temp_dir} ...`);
    execSync('node node_modules/react-scripts/scripts/build.js', { cwd: temp_dir, stdio: 'inherit' });
    console.log('Build succeeded');

    return `${temp_dir}/build`;
}

async function buildUploadSpa(action: 'Create' | 'Update' | 'Delete', config: Configuration, physicalResourceId?: string) {
    if (action === 'Create' || action === 'Update') {
        const buildDir = await buildSpa(config);
        await s3SpaUpload(buildDir, config.BucketName);
    } else {
        // "Trick" to empty the bucket is to upload an empty dir
        mkdirSync('/tmp/empty_directory', { recursive: true });
        await s3SpaUpload('/tmp/empty_directory', config.BucketName, { delete: true });
    }
    return physicalResourceId || "ReactApp";
}

export const handler: CloudFormationCustomResourceHandler = async (event, context) => {
    console.log(JSON.stringify(event, undefined, 4));

    const {
        LogicalResourceId,
        RequestId,
        StackId,
        ResponseURL,
        ResourceProperties,
        RequestType,
    } = event;

    const { ServiceToken, ...config } = ResourceProperties;

    const { PhysicalResourceId } = event as CloudFormationCustomResourceDeleteEvent | CloudFormationCustomResourceUpdateEvent;

    let response: CloudFormationCustomResourceResponse;
    try {
        const physicalResourceId = await Promise.race([
            buildUploadSpa(RequestType, config as Configuration, PhysicalResourceId),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Task timeout')), context.getRemainingTimeInMillis() - 500))
        ]);
        response = {
            LogicalResourceId,
            PhysicalResourceId: physicalResourceId as string,
            Status: 'SUCCESS',
            RequestId,
            StackId,
            Data: {}
        };
    } catch (err) {
        console.error(err);
        response = {
            LogicalResourceId,
            PhysicalResourceId: PhysicalResourceId || `failed-to-create-${Date.now()}`,
            Status: 'FAILED',
            Reason: err.stack || err.message,
            RequestId,
            StackId,
        };
    }
    await axios.put(ResponseURL, response, { headers: { 'content-type': '' } });
}

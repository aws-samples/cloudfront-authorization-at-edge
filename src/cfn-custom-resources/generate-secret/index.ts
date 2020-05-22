// Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { randomBytes } from 'crypto';
import {
    CloudFormationCustomResourceHandler,
    CloudFormationCustomResourceResponse,
    CloudFormationCustomResourceDeleteEvent,
    CloudFormationCustomResourceUpdateEvent
} from 'aws-lambda';
import axios from 'axios';

export const handler: CloudFormationCustomResourceHandler = async (event) => {
    console.log(JSON.stringify(event, undefined, 4));
    const {
        LogicalResourceId,
        RequestId,
        StackId,
        ResponseURL,
        ResourceProperties
    } = event;

    const { PhysicalResourceId } = event as CloudFormationCustomResourceDeleteEvent | CloudFormationCustomResourceUpdateEvent;

    const { Length = 16, AllowedCharacters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~' } = ResourceProperties;

    let response: CloudFormationCustomResourceResponse;
    try {
        const physicalResourceId = PhysicalResourceId || [...new Array(parseInt(Length))].map(() => randomChoiceFromIndexable(AllowedCharacters)).join('');;
        response = {
            LogicalResourceId,
            PhysicalResourceId: physicalResourceId!,
            Status: 'SUCCESS',
            RequestId,
            StackId,
        };
    } catch (err) {
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

function randomChoiceFromIndexable(indexable: string) {
    if (indexable.length > 256) {
        throw new Error(`indexable is too large: ${indexable.length}`);
    }
    const chunks = Math.floor(256 / indexable.length);
    const firstBiassedIndex = indexable.length * chunks;
    let randomNumber: number;
    do {
        randomNumber = randomBytes(1)[0];
    } while (randomNumber >= firstBiassedIndex)
    const index = randomNumber % indexable.length;
    return indexable[index];
}

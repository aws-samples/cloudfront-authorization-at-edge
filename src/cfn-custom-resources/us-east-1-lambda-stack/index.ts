/*
    Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.
    SPDX-License-Identifier: MIT-0

    This is a CloudFormation custom resource. It's purpose is to:

    - ...
*/

import {
  CloudFormationCustomResourceHandler,
  CloudFormationCustomResourceDeleteEvent,
  CloudFormationCustomResourceUpdateEvent,
} from "aws-lambda";
import CloudFormation from "aws-sdk/clients/CloudFormation";
import S3 from "aws-sdk/clients/s3";
import { sendCfnResponse, Status } from "./cfn-response";

const CFN_CLIENT = new CloudFormation();
const CFN_CLIENT_US_EAST_1 = new CloudFormation({ region: "us-east-1" });
const S3_CLIENT = new S3();
const S3_CLIENT_US_EAST_1 = new S3({ region: "us-east-1" });

interface CfnTemplateBase {
  Resources: {
    [key: string]: {
      Type: string;
      Condition?: string;
      Properties?: {
        [key: string]: any;
      };
    };
  };
  Outputs?: {
    [key: string]: {
      Value: {
        Ref: string;
      };
    };
  };
}

interface CfnTemplateWithLambdas extends CfnTemplateBase {
  Resources: {
    CheckAuthHandler: CfnLambdaResource;
    ParseAuthHandler: CfnLambdaResource;
    RefreshAuthHandler: CfnLambdaResource;
    HttpHeadersHandler: CfnLambdaResource;
    SignOutHandler: CfnLambdaResource;
  };
}

interface CfnLambdaResource {
  Type: string;
  Condition?: string;
  Properties: {
    Code: {
      S3Bucket: string;
      S3Key: string;
    };
    Role: string;
    [key: string]: any;
  };
}

const US_EAST_1_STACK_BASE_TEMPLATE = JSON.stringify({
  Resources: {
    DeploymentBucket: {
      Type: "AWS::S3::Bucket",
    },
  },
  Outputs: {
    DeploymentBucket: {
      Value: {
        Ref: "DeploymentBucket",
      },
    },
  },
} as CfnTemplateBase);

const LAMBDA_NAMES = [
  "CheckAuthHandler",
  "ParseAuthHandler",
  "RefreshAuthHandler",
  "HttpHeadersHandler",
  "SignOutHandler",
] as const;

async function ensureUsEast1LambdaStack(props: {
  stackId: string;
  stackName: string;
  lambdaRoleArn: string;
  requestType: "Create" | "Update" | "Delete";
  physicalResourceId: string | undefined;
}) {
  if (props.requestType === "Delete") {
    await CFN_CLIENT_US_EAST_1.deleteStack({
      StackName: props.stackName,
    }).promise();
    return;
  }
  const deploymentBucket = await ensureDeploymentUsEast1Stack(props);
  const { TemplateBody: originalTemplate } = await CFN_CLIENT.getTemplate({
    StackName: props.stackId,
    TemplateStage: "Processed",
  }).promise();
  if (!originalTemplate)
    throw new Error(
      `Failed to get template for stack ${props.stackName} (${props.stackId})`
    );
  const parsedOriginalTemplate = JSON.parse(
    originalTemplate
  ) as CfnTemplateWithLambdas;
  const templateForUsEast1 = JSON.parse(US_EAST_1_STACK_BASE_TEMPLATE);
  await Promise.all(
    LAMBDA_NAMES.map((lambdaName) => {
      copyLambdaCodeToUsEast1({
        fromBucket:
          parsedOriginalTemplate.Resources[lambdaName].Properties.Code.S3Bucket,
        toBucket: deploymentBucket,
        key: parsedOriginalTemplate.Resources[lambdaName].Properties.Code.S3Key,
      }).then(() => {
        const updatedLambdaResource: CfnLambdaResource =
          parsedOriginalTemplate.Resources[lambdaName];
        updatedLambdaResource.Properties.Code.S3Bucket = deploymentBucket;
        delete updatedLambdaResource.Condition;
        updatedLambdaResource.Properties.Role = props.lambdaRoleArn;
        templateForUsEast1.Resources[lambdaName] = updatedLambdaResource;
      });
    })
  );
  return await ensureLambdaUsEast1Stack({
    ...props,
    newTemplate: templateForUsEast1,
  });
}

async function ensureLambdaUsEast1Stack(props: {
  stackId: string;
  stackName: string;
  newTemplate: string;
}) {
  const { Id: changeSetArn } = await CFN_CLIENT_US_EAST_1.createChangeSet({
    StackName: props.stackName,
    ChangeSetName: "CreateOrUpdateLambdaHandlers",
    TemplateBody: props.newTemplate,
  }).promise();
  if (!changeSetArn)
    throw new Error(
      "Failed to create change set for lambda handlers deployment"
    );
  await CFN_CLIENT_US_EAST_1.waitFor("changeSetCreateComplete", {
    ChangeSetName: changeSetArn,
  }).promise();
  await CFN_CLIENT_US_EAST_1.executeChangeSet({
    ChangeSetName: changeSetArn,
  }).promise();
  const { Stacks: updatedStacks } = await CFN_CLIENT_US_EAST_1.waitFor(
    "stackUpdateComplete",
    {
      StackName: props.stackName,
    }
  ).promise();
  const outputs = LAMBDA_NAMES.reduce((acc, lambdaName) => {
    const lambdaArn = updatedStacks?.[0].Outputs?.find(
      (output) => output.OutputKey === lambdaName
    )?.OutputValue;
    return { ...acc, [lambdaName]: lambdaArn };
  }, {} as { [key: string]: string | undefined });
  if (!Object.values(outputs).every((lambdaArn) => !!lambdaArn))
    throw new Error(
      `Failed to locate (all) lambda arns in us-east-1 stack: ${outputs}`
    );
  return outputs as { [key: string]: string };
}

async function ensureDeploymentUsEast1Stack(props: {
  stackId: string;
  stackName: string;
}) {
  const { Stacks: stacks } = await CFN_CLIENT_US_EAST_1.describeStacks({
    StackName: props.stackId,
  }).promise();
  if (stacks?.length) {
    const deploymentBucket = stacks[0].Outputs?.find(
      (output) => output.OutputKey === "DeploymentBucket"
    )?.OutputValue;
    if (!deploymentBucket)
      throw new Error("Failed to locate deployment bucket in us-east-1 stack");
    return deploymentBucket;
  }
  const { Id: changeSetArn } = await CFN_CLIENT_US_EAST_1.createChangeSet({
    StackName: props.stackName,
    ChangeSetName: "CreateDeploymentBucket",
    TemplateBody: US_EAST_1_STACK_BASE_TEMPLATE,
  }).promise();
  if (!changeSetArn)
    throw new Error("Failed to create change set for bucket deployment");
  await CFN_CLIENT_US_EAST_1.waitFor("changeSetCreateComplete", {
    ChangeSetName: changeSetArn,
  }).promise();
  await CFN_CLIENT_US_EAST_1.executeChangeSet({
    ChangeSetName: changeSetArn,
  }).promise();
  const { Stacks: createdStacks } = await CFN_CLIENT_US_EAST_1.waitFor(
    "stackCreateComplete",
    {
      StackName: props.stackName,
    }
  ).promise();
  const deploymentBucket = createdStacks?.[0].Outputs?.find(
    (output) => output.OutputKey === "DeploymentBucket"
  )?.OutputValue;
  if (!deploymentBucket)
    throw new Error("Failed to locate deployment bucket in new stack");
  return deploymentBucket;
}

async function copyLambdaCodeToUsEast1(props: {
  fromBucket: string;
  toBucket: string;
  key: string;
}) {
  const { Body } = await S3_CLIENT.getObject({
    Bucket: props.fromBucket,
    Key: props.key,
  }).promise();
  await S3_CLIENT_US_EAST_1.putObject({
    Bucket: props.toBucket,
    Key: props.key,
    Body,
  }).promise();
  return props;
}

export const handler: CloudFormationCustomResourceHandler = async (event) => {
  console.log(JSON.stringify(event, undefined, 4));
  const { StackId: stackId, RequestType: requestType } = event;
  const stackName = stackId.split("/")[1];

  const {
    PhysicalResourceId: physicalResourceId,
    ResourceProperties: { LambdaRoleArn: lambdaRoleArn },
  } = event as
    | CloudFormationCustomResourceDeleteEvent
    | CloudFormationCustomResourceUpdateEvent;

  let status = Status.SUCCESS;
  let data: { [key: string]: any } | undefined;
  let reason: string | undefined;
  try {
    data = await ensureUsEast1LambdaStack({
      stackId,
      stackName,
      physicalResourceId,
      requestType,
      lambdaRoleArn,
    });
  } catch (err) {
    console.error(err);
    status = Status.FAILED;
    reason = err;
  }
  await sendCfnResponse({
    event,
    status,
    data,
    physicalResourceId: stackName,
    reason,
  });
};

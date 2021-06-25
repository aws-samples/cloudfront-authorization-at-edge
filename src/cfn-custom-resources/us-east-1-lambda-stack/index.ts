/*
    Copyright 2021 Amazon.com, Inc. or its affiliates. All Rights Reserved.
    SPDX-License-Identifier: MIT-0

    This is a CloudFormation custom resource. It's purpose is to copy the Lambda@Edge functions to us-east-1
    as that a requirement from CloudFront.

    To this end, in us-east-1 a separate stack will be created with just these Lambda@Edge functions.
*/

import {
  CloudFormationCustomResourceHandler,
  CloudFormationCustomResourceDeleteEvent,
  CloudFormationCustomResourceUpdateEvent,
} from "aws-lambda";
import CloudFormation from "aws-sdk/clients/cloudformation";
import S3 from "aws-sdk/clients/s3";
import Lambda from "aws-sdk/clients/lambda";
import { sendCfnResponse, Status } from "./cfn-response";
import { fetch } from "./https";

const CFN_CLIENT = new CloudFormation();
const CFN_CLIENT_US_EAST_1 = new CloudFormation({ region: "us-east-1" });
const LAMBDA_CLIENT = new Lambda();
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
  Outputs: {
    [key: string]: {
      Value: {
        "Fn::GetAtt"?: string[];
        Ref?: string;
      };
      Export?: {
        Name: {
          "Fn::Sub": string;
        };
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
  checkAuthHandlerArn: string;
  parseAuthHandlerArn: string;
  refreshAuthHandlerArn: string;
  httpHeadersHandlerArn: string;
  signOutHandlerArn: string;
  lambdaRoleArn: string;
  requestType: "Create" | "Update" | "Delete";
  physicalResourceId: string | undefined;
}) {
  if (props.requestType === "Delete") {
    const { Stacks: stacks } = await CFN_CLIENT_US_EAST_1.describeStacks({
      StackName: props.stackName,
    })
      .promise()
      .catch(() => ({ Stacks: undefined }));
    if (stacks?.length) {
      await CFN_CLIENT_US_EAST_1.deleteStack({
        StackName: props.stackName,
      }).promise();
      return;
    }
  }
  const deploymentBucket = await ensureDeploymentUsEast1Stack(props);
  console.log("Getting CFN template ...");
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
  const templateForUsEast1 = JSON.parse(
    US_EAST_1_STACK_BASE_TEMPLATE
  ) as CfnTemplateWithLambdas;
  await Promise.all(
    LAMBDA_NAMES.map((lambdaName) => {
      const lambdaProperty = Object.entries(props).find(
        ([key, lambdaArn]) =>
          key.toLowerCase().startsWith(lambdaName.toLowerCase()) && !!lambdaArn
      );
      if (!lambdaProperty) {
        throw new Error(
          `Couldn't locate ARN for lambda ${lambdaName} in input properties: ${JSON.stringify(
            props,
            null,
            2
          )}`
        );
      }
      return copyLambdaCodeToUsEast1({
        lambdaArn: lambdaProperty[1]!,
        toBucket: deploymentBucket,
        key: parsedOriginalTemplate.Resources[lambdaName].Properties.Code.S3Key,
      }).then(() => {
        const updatedLambdaResource: CfnLambdaResource =
          parsedOriginalTemplate.Resources[lambdaName];
        updatedLambdaResource.Properties.Code.S3Bucket = deploymentBucket;
        delete updatedLambdaResource.Condition;
        updatedLambdaResource.Properties.Role = props.lambdaRoleArn;
        templateForUsEast1.Resources[lambdaName] = updatedLambdaResource;
        templateForUsEast1.Outputs[lambdaName] = {
          Value: {
            "Fn::GetAtt": [lambdaName, "Arn"],
          },
          Export: {
            Name: {
              "Fn::Sub": "${AWS::StackName}-" + lambdaName,
            },
          },
        };
      });
    })
  );
  console.log(
    "Constructed CloudFormation template for Lambda's:",
    JSON.stringify(templateForUsEast1, null, 2)
  );
  return await ensureLambdaUsEast1Stack({
    ...props,
    newTemplate: JSON.stringify(templateForUsEast1),
  });
}

async function ensureLambdaUsEast1Stack(props: {
  stackId: string;
  stackName: string;
  newTemplate: string;
}) {
  console.log(
    "Creating change set for adding lambda functions to us-east-1 stack ..."
  );
  const { Id: changeSetArn } = await CFN_CLIENT_US_EAST_1.createChangeSet({
    StackName: props.stackName,
    ChangeSetName: props.stackName,
    TemplateBody: props.newTemplate,
    ChangeSetType: "UPDATE",
    ResourceTypes: ["AWS::Lambda::Function"],
  }).promise();
  if (!changeSetArn)
    throw new Error(
      "Failed to create change set for lambda handlers deployment"
    );
  console.log(
    "Waiting for completion of change set for adding lambda functions to us-east-1 stack ..."
  );
  await CFN_CLIENT_US_EAST_1.waitFor("changeSetCreateComplete", {
    ChangeSetName: changeSetArn,
  })
    .promise()
    .catch((err) =>
      console.log(
        `Caught exception while waiting for change set create completion: ${err}`
      )
    );
  const { Status: status, StatusReason: reason } =
    await CFN_CLIENT_US_EAST_1.describeChangeSet({
      ChangeSetName: changeSetArn,
    }).promise();
  if (status === "FAILED") {
    if (!reason?.includes("didn't contain changes")) {
      throw new Error(`Failed to create change set: ${reason}`);
    } else {
      await CFN_CLIENT_US_EAST_1.deleteChangeSet({
        ChangeSetName: changeSetArn,
      }).promise();
      const { Stacks: existingStacks } =
        await CFN_CLIENT_US_EAST_1.describeStacks({
          StackName: props.stackName,
        }).promise();
      const existingOutputs = LAMBDA_NAMES.reduce((acc, lambdaName) => {
        const lambdaArn = existingStacks?.[0].Outputs?.find(
          (output) => output.OutputKey === lambdaName
        )?.OutputValue;
        return { ...acc, [lambdaName]: lambdaArn };
      }, {} as { [key: string]: string | undefined });
      if (!Object.values(existingOutputs).every((lambdaArn) => !!lambdaArn))
        throw new Error(
          `Failed to locate (all) lambda arns in us-east-1 stack: ${existingOutputs}`
        );
      console.log(
        `us-east-1 stack unchanged. Stack outputs: ${JSON.stringify(
          existingOutputs,
          null,
          2
        )}`
      );
      return existingOutputs as { [key: string]: string };
    }
  }

  console.log(
    "Executing change set for adding lambda functions to us-east-1 stack ..."
  );
  await CFN_CLIENT_US_EAST_1.executeChangeSet({
    ChangeSetName: changeSetArn,
  }).promise();
  console.log(
    "Waiting for completion of execute change set for adding lambda functions to us-east-1 stack ..."
  );
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
  console.log(
    `us-east-1 stack succesfully updated. Stack outputs: ${JSON.stringify(
      outputs,
      null,
      2
    )}`
  );
  return outputs as { [key: string]: string };
}

async function ensureDeploymentUsEast1Stack(props: {
  stackId: string;
  stackName: string;
}) {
  console.log("Checking if us-east-1 stack already exists ...");
  const { Stacks: stacks } = await CFN_CLIENT_US_EAST_1.describeStacks({
    StackName: props.stackName,
  })
    .promise()
    .catch(() => ({ Stacks: undefined }));
  if (stacks?.length) {
    const deploymentBucket = stacks[0].Outputs?.find(
      (output) => output.OutputKey === "DeploymentBucket"
    )?.OutputValue;
    if (!deploymentBucket)
      throw new Error("Failed to locate deployment bucket in us-east-1 stack");
    console.log(
      `us-east-1 stack exists. Deployment bucket: ${deploymentBucket}`
    );
    return deploymentBucket;
  }
  console.log("Creating change set for us-east-1 stack ...");
  const { Id: changeSetArn } = await CFN_CLIENT_US_EAST_1.createChangeSet({
    StackName: props.stackName,
    ChangeSetName: props.stackName,
    TemplateBody: US_EAST_1_STACK_BASE_TEMPLATE,
    ChangeSetType: "CREATE",
    ResourceTypes: ["AWS::S3::Bucket"],
  }).promise();
  if (!changeSetArn)
    throw new Error("Failed to create change set for bucket deployment");
  console.log("Waiting for change set create complete for us-east-1 stack ...");
  await CFN_CLIENT_US_EAST_1.waitFor("changeSetCreateComplete", {
    ChangeSetName: changeSetArn,
  }).promise();
  console.log("Executing change set for us-east-1 stack ...");
  await CFN_CLIENT_US_EAST_1.executeChangeSet({
    ChangeSetName: changeSetArn,
  }).promise();
  console.log("Waiting for creation of us-east-1 stack ...");
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
  lambdaArn: string;
  toBucket: string;
  key: string;
}) {
  console.log(`Copying Lambda code: ${JSON.stringify(props, null, 2)}`);
  const { Code } = await LAMBDA_CLIENT.getFunction({
    FunctionName: props.lambdaArn,
  }).promise();
  console.log(
    `Downloading lambda code for ${props.lambdaArn} from ${Code!.Location!}`
  );
  const data = await fetch(Code!.Location!);
  await S3_CLIENT_US_EAST_1.putObject({
    Bucket: props.toBucket,
    Key: props.key,
    Body: data,
  }).promise();
  return props;
}

export const handler: CloudFormationCustomResourceHandler = async (event) => {
  console.log(JSON.stringify(event, undefined, 4));
  const { StackId: stackId, RequestType: requestType } = event;
  const stackName = stackId.split("/")[1];

  const {
    PhysicalResourceId: physicalResourceId,
    ResourceProperties: {
      LambdaRoleArn: lambdaRoleArn,
      CheckAuthHandlerArn: checkAuthHandlerArn,
      ParseAuthHandlerArn: parseAuthHandlerArn,
      RefreshAuthHandlerArn: refreshAuthHandlerArn,
      HttpHeadersHandlerArn: httpHeadersHandlerArn,
      SignOutHandlerArn: signOutHandlerArn,
    },
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
      checkAuthHandlerArn,
      parseAuthHandlerArn,
      refreshAuthHandlerArn,
      httpHeadersHandlerArn,
      signOutHandlerArn,
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

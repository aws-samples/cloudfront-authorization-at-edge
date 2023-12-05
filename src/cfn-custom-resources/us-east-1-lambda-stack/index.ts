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
    TrailingSlashHandler?: CfnLambdaResource;
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
  Description: [
    "Protect downloads of your content hosted on CloudFront with Cognito authentication using Lambda@Edge.",
    `This is a peripheral stack to the main stack (with the same name) in region ${CFN_CLIENT.config.region}.`,
    "This stack contains the Lambda@Edge functions, these must be deployed to us-east-1",
  ].join(" "),
  Resources: {
    AuthEdgeDeploymentBucket: {
      Type: "AWS::S3::Bucket",
    },
  },
  Outputs: {
    DeploymentBucket: {
      Value: {
        Ref: "AuthEdgeDeploymentBucket",
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
  "TrailingSlashHandler",
] as const;

async function ensureUsEast1LambdaStack(props: {
  stackId: string;
  stackName: string;
  checkAuthHandlerArn: string;
  parseAuthHandlerArn: string;
  refreshAuthHandlerArn: string;
  httpHeadersHandlerArn: string;
  signOutHandlerArn: string;
  trailingSlashHandlerArn?: string;
  lambdaRoleArn: string;
  requestType: "Create" | "Update" | "Delete";
  physicalResourceId: string | undefined;
}) {
  // This function will create/update a stack in us-east-1, with the Lambda@Edge functions
  // (or clean up after itself upon deleting)

  // If we're deleting, delete the us-east-1 stack, if it still exists
  if (props.requestType === "Delete") {
    console.log("Getting status of us-east-1 stack ...");
    const { Stacks: stacks } = await CFN_CLIENT_US_EAST_1.describeStacks({
      StackName: props.stackName,
    })
      .promise()
      .catch(() => ({ Stacks: undefined }));
    if (stacks?.length) {
      console.log("Deleting us-east-1 stack ...");
      const deploymentBucket = stacks[0].Outputs?.find(
        (output) => output.OutputKey === "DeploymentBucket"
      )?.OutputValue;
      if (deploymentBucket) {
        await emptyBucket({ bucket: deploymentBucket });
      }
      await CFN_CLIENT_US_EAST_1.deleteStack({
        StackName: props.stackName,
      }).promise();
      console.log("us-east-1 stack deleted");
    } else {
      console.log("us-east-1 stack already deleted");
    }
    return;
  }

  // To be able to create the Lambda@Edge functions in us-east-1 we first need to create
  // an S3 bucket there, to hold the code.
  const deploymentBucket = await ensureDeploymentUsEast1Stack(props);

  // To get the Lambda@Edge configuration, we'll simply download the CloudFormation template for
  // this, the current, stack, and use the configuration that is in there.
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

  // For each concerned lambda, extract it's configuration from the downloaded CloudFormation template
  // and add it to the new template, for us-east-1 deployment
  await Promise.all(
    LAMBDA_NAMES.map((lambdaName) => {
      const lambdaProperty = Object.entries(props).find(
        ([key, lambdaArn]) =>
          key.toLowerCase().startsWith(lambdaName.toLowerCase()) && !!lambdaArn
      );
      const lambdaArn = lambdaProperty && lambdaProperty[1];
      if (!lambdaArn) {
        console.log(
          `Couldn't locate ARN for lambda ${lambdaName} in input properties: ${JSON.stringify(
            props,
            null,
            2
          )}`
        );
        return;
      }
      // Copy the Lambda code to us-east-1, and set that location in the new CloudFormation template
      const lambdaResource = parsedOriginalTemplate.Resources[lambdaName]!;
      return copyLambdaCodeToUsEast1({
        lambdaArn,
        toBucket: deploymentBucket,
        key: lambdaResource.Properties.Code.S3Key,
      }).then(() => {
        const updatedLambdaResource: CfnLambdaResource = lambdaResource;
        updatedLambdaResource.Properties.Code.S3Bucket = deploymentBucket;
        delete updatedLambdaResource.Condition;
        updatedLambdaResource.Properties.Role = props.lambdaRoleArn;
        updatedLambdaResource.Properties.FunctionName = lambdaArn
          .split(":")
          .pop();
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

  // Deploy the template with the Lambda@Edge functions to us-east-1
  return ensureLambdaUsEast1Stack({
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
    // The only reason we'll allow a FAILED change set is if there were no changes
    if (!reason?.includes("didn't contain changes")) {
      throw new Error(`Failed to create change set: ${reason}`);
    } else {
      // No changes to make to the Lambda@Edge functions, clean up the change set then
      await CFN_CLIENT_US_EAST_1.deleteChangeSet({
        ChangeSetName: changeSetArn,
      }).promise();

      // Need to get the outputs (Lambda ARNs) from the existing stack then
      const { Stacks: existingStacks } =
        await CFN_CLIENT_US_EAST_1.describeStacks({
          StackName: props.stackName,
        }).promise();
      const existingOutputs = extractOutputsFromStackResponse(existingStacks);
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

  // Execute change set and wait for completion
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
  const outputs = extractOutputsFromStackResponse(updatedStacks);
  console.log(
    `us-east-1 stack succesfully updated. Stack outputs: ${JSON.stringify(
      outputs,
      null,
      2
    )}`
  );
  return outputs as { [key: string]: string };
}

function extractOutputsFromStackResponse(stacks?: CloudFormation.Stack[]) {
  // find the ARNs for all Lambda functions, which will be output from this custom resource

  const outputs = LAMBDA_NAMES.reduce((acc, lambdaName) => {
    const lambdaArn = stacks?.[0].Outputs?.find(
      (output) => output.OutputKey === lambdaName
    )?.OutputValue;
    if (lambdaArn) {
      return { ...acc, [lambdaName]: lambdaArn };
    } else {
      return acc;
    }
  }, {} as { [key: string]: string | undefined });
  return outputs;
}

async function ensureDeploymentUsEast1Stack(props: {
  stackId: string;
  stackName: string;
}) {
  // Create a stack in us-east-1 with a deployment bucket
  // (in a next step, Lambda fuctions will be added to this stack)

  console.log("Checking if us-east-1 stack already exists ...");
  const { Stacks: usEast1Stacks } = await CFN_CLIENT_US_EAST_1.describeStacks({
    StackName: props.stackName,
  })
    .promise()
    .catch(() => ({ Stacks: undefined }));
  if (usEast1Stacks?.length) {
    const deploymentBucket = usEast1Stacks[0].Outputs?.find(
      (output) => output.OutputKey === "DeploymentBucket"
    )?.OutputValue;
    if (!deploymentBucket)
      throw new Error("Failed to locate deployment bucket in us-east-1 stack");
    console.log(
      `us-east-1 stack exists. Deployment bucket: ${deploymentBucket}`
    );
    return deploymentBucket;
  }

  // Get the stack tags, we'll add them to the peripheral stack in us-east-1 too
  console.log("Getting CFN stack tags ...");
  const { Stacks: mainRegionStacks } = await CFN_CLIENT.describeStacks({
    StackName: props.stackId,
  }).promise();
  if (!mainRegionStacks?.length) {
    throw new Error(
      `Failed to describe stack ${props.stackName} (${props.stackId})`
    );
  }

  // Create the stack
  console.log("Creating change set for us-east-1 stack ...");
  const { Id: changeSetArn } = await CFN_CLIENT_US_EAST_1.createChangeSet({
    StackName: props.stackName,
    ChangeSetName: props.stackName,
    TemplateBody: US_EAST_1_STACK_BASE_TEMPLATE,
    ChangeSetType: "CREATE",
    ResourceTypes: ["AWS::S3::Bucket"],
    Tags: mainRegionStacks[0].Tags,
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

async function emptyBucket(props: { bucket: string }) {
  const params: S3.ListObjectsV2Request = {
    Bucket: props.bucket,
  };
  do {
    console.log(`Listing objects in bucket ${props.bucket} ...`);
    const { Contents: s3objects, NextContinuationToken } =
      await S3_CLIENT_US_EAST_1.listObjectsV2(params).promise();

    if (!s3objects?.length) break;
    console.log(`Deleting ${s3objects.length} S3 objects ...`);

    const { Errors: errors } = await S3_CLIENT_US_EAST_1.deleteObjects({
      Bucket: props.bucket,
      Delete: {
        Objects: s3objects.filter((o) => !!o.Key).map((o) => ({ Key: o.Key! })),
      },
    }).promise();

    if (errors?.length) {
      console.log("Failed to delete objects:", JSON.stringify(errors));
    }

    params.ContinuationToken = NextContinuationToken;
  } while (params.ContinuationToken);
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
      TrailingSlashHandlerArn: trailingSlashHandlerArn,
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
      trailingSlashHandlerArn,
    });
  } catch (err) {
    console.error(err);
    status = Status.FAILED;
    reason = `${err}`;
  }
  await sendCfnResponse({
    event,
    status,
    data,
    physicalResourceId: stackName,
    reason,
  });
};

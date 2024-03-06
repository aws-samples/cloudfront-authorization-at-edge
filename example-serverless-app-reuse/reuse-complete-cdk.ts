#!/usr/bin/env ts-node

/**
 * CDK Example showing how to deploy the SAR app through CDK, with parameters and outputs
 *
 * E.g. run CDK synth like so:
 *   cdk synth --app ./cdk-example.ts
 *
 * Deployment:
 *   cdk deploy --app ./cdk-example.ts
 */

import * as cdk from "@aws-cdk/core";
import * as sam from "@aws-cdk/aws-sam";

const stack = new cdk.Stack(new cdk.App(), "example-cdk-stack");

const authAtEdge = new sam.CfnApplication(stack, "AuthorizationAtEdge", {
  location: {
    applicationId:
      "arn:aws:serverlessrepo:us-east-1:520945424137:applications/cloudfront-authorization-at-edge",
    semanticVersion: "2.2.1",
  },
  parameters: {
    EmailAddress: "johndoe@example.com",
  },
});

new cdk.CfnOutput(stack, "ProtectedS3Bucket", {
  value: authAtEdge.getAtt("Outputs.S3Bucket").toString(),
});

## CloudFront authorization@edge

This repo accompanies the [blog post](https://aws.amazon.com/blogs/networking-and-content-delivery/).

In that blog post a solution is explained, that puts Cognito authentication in front of (S3) downloads from CloudFront, using Lambda@Edge. JWT's are transferred using cookies to make authorization transparent to clients.

The sources in this repo implement that solution.

The purpose of this sample code is to demonstrate how Lambda@Edge can be used to implement authorization, with Cognito as identity provider (IDP). Please treat the code as an _**illustration**_––thoroughly review it and adapt it to your needs, if you want to use it for serious things.

## Repo contents

This repo contains (a.o.) the following files and directories:

Lambda@Edge functions in [src/lambda-edge](src/lambda-edge):

- [check-auth](src/lambda-edge/check-auth): Lambda@Edge function that checks each incoming request for valid JWT's in the request cookies
- [parse-auth](src/lambda-edge/parse-auth): Lambda@Edge function that handles the redirect from the Cognito hosted UI, after the user signed in
- [refresh-auth](src/lambda-edge/refresh-auth): Lambda@Edge function that handles JWT refresh requests
- [sign-out](src/lambda-edge/sign-out): Lambda@Edge function that handles sign-out
- [http-headers](src/lambda-edge/http-headers): Lambda@Edge function that sets HTTP security headers (as good practice)

CloudFormation custom resources in [src/cfn-custom-resources](src/cfn-custom-resources):

- [react-app](src/cfn-custom-resources/react-app): A sample React app that is protected by the solution. It uses AWS Amplify Framework to read the JWT's from cookies. The directory also contains a Lambda function that implements a CloudFormation custom resource to build the React app and upload it to S3
- [user-pool-client](src/cfn-custom-resources/user-pool-client): Lambda function that implements a CloudFormation custom resource to update the User Pool client with OAuth config
- [user-pool-domain](src/cfn-custom-resources/user-pool-domain): Lambda function that implements a CloudFormation custom resource to update the User Pool with a domain for the hosted UI
- [lambda-code-update](src/cfn-custom-resources/lambda-code-update): Lambda function that implements a CloudFormation custom resource to inject configuration into the lambda@Edge functions and publish versions
- [shared](src/lambda-edge/shared): Utility functions used by several Lambda@Edge functions

Other files and directories:

- [./example-serverless-app-reuse](./example-serverless-app-reuse): Contains an example SAM template that shows how to reuse this application from the Serverless Application Repository in your own SAM templates.
- [./template.yaml](./template.yaml): The SAM template that comprises the solution
- [./webpack.config.js](./webpack.config.js): Webpack config for the Lambda@Edge functions and for the React-app custom resource
- [./tsconfig.json](./tsconfig.json): TypeScript configuration for this project

## Deploying the solution

### Option 1: Deploy through the Serverless Application Repository

The solution can be deployed with a few clicks through the [Serverless Application Repository](https://console.aws.amazon.com/lambda/home#/create/app?applicationId=arn:aws:serverlessrepo:us-east-1:520945424137:applications/spa-authorization-at-edge).

### Option 2: Deploy with SAM CLI

#### Pre-requisites

1. Download and install [Node.js](https://nodejs.org/en/download/)
2. Download and install [AWS SAM CLI](https://github.com/awslabs/aws-sam-cli)
3. Of course you need an AWS account and necessary permissions to create resources in it. Make sure your AWS credentials can be found during deployment, e.g. by making your AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY available as environment variables.
5. You need an existing S3 bucket to use for the SAM deployment. Create an empty bucket.

NOTE: Deploy this application to region us-east-1. This is because Lambda@Edge must be deployed to us-east-1 as it is a global configuration.

#### Deployment

1. Clone this repo `git clone https://github.com/aws-samples/spa-authorization-at-edge`
2. Install dependencies: `npm install`
3. TypeScript compile and run Webpack: `npm run build`
4. Run SAM build. Use a container to support binaries: `sam build --use-container`
5. Run SAM package: `sam package --output-template-file packaged.yaml --s3-bucket <Your SAM bucket> --region us-east-1`
6. Run SAM deploy: `sam deploy --template-file packaged.yaml --stack-name <Your Stack Name> --capabilities CAPABILITY_IAM --parameter-overrides EmailAddress=<your email> --region us-east-1`

Providing an email address (as above in step 6) is optional. If you provide it, a user will be created in the Cognito User Pool that you can sign-in with.

### Option 3: Deploy by including the Serverless Application in your own CloudFormation template

See [./example-serverless-app-reuse](./example-serverless-app-reuse)

## I already have a CloudFront distribution, I just want to add auth

Deploy the solution while setting parameter `CreateCloudFrontDistribution` to `false`. This way, only the Lambda@Edge functions will de deployed in your account, including a User Pool and Client. Then you can wire those Lambda@Edge functions up into your own CloudFront distribution.

The CloudFormation Stack's Outputs contain the Lambda Version ARNs that you can refer to in your CloudFront distribution.

When following this route, also provide parameter `AlternateDomainNames` upon deploying, so the correct redirect URL's can be configured for you in the Cognito User Pool Client.

## License Summary

This sample code is made available under a modified MIT license. See the [LICENSE](./LICENSE) file.

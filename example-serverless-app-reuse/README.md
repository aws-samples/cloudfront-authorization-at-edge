# Examples that show how to reuse the serverless application in your own CloudFormation/SAM templates

This directory contains the following examples:

## [reuse-complete.yaml](./reuse-complete.yaml)
This examples shows how you can add some users of your own to the serverless application's User Pool. Also it shows how you can access outputs from the serverless application.

## [reuse-auth-only.yaml](./reuse-auth-only.yaml)
This example shows how to wire up this solution's auth functions into your own CloudFront distribution. Features include:

- An example private S3 bucket resource and parameter to name it
- An example functional CloudFront distribution providing access to the bucket by Origin Access Identity
- The nested reused serverless application stack resource illustrating how to pass your  template's parameters to the application, in this case to modify http headers
- An example showing how to retrieve output parameters from the nested application stack for use in the outer template
- Parameterized semantic version to allow operation with future versions of the application
- Note the instructions on updating the User Pool client in this example's description.

## [reuse-with-existing-user-pool.yaml](./reuse-with-existing-user-pool.yaml)
This example shows how to reuse the serverless application with a pre-existing User Pool and Client.

## Deployment

You can deploy the examples as follows:

```sh
#!/bin/sh

STACK_NAME=my-protected-cloudfront-stack
TEMPLATE=reuse-complete.yaml # Or one of the other ones

sam deploy --template-file $TEMPLATE --stack-name $STACK_NAME \
           --capabilities CAPABILITY_IAM CAPABILITY_AUTO_EXPAND --region us-east-1

```

or simply launch the sample template in CloudFormation
# Examples that show how to reuse the serverless application in your own CloudFormation/SAM templates

This directory contains two examples:

- [reuse-complete.yaml](./reuse-complete.yaml): This examples shows how you can add some users of your own to the serverless application's User Pool. Also it shows how you can access outputs from the serverless application.

- [reuse-auth-only.yaml](./reuse-auth-only.yaml): This example shows how you can wire up this solution's auth functions into your own CloudFront distribution. Note the instructions on updating the User Pool client in this example's description.

## Deployment

You can deploy the examples as follows:

```sh
#!/bin/sh

STACK_NAME=my-protected-cloudfront-stack
TEMPLATE=reuse-complete.yaml # Or reuse-auth-only.yaml

sam deploy --template-file $TEMPLATE --stack-name $STACK_NAME \
           --capabilities CAPABILITY_IAM CAPABILITY_AUTO_EXPAND --region us-east-1

```


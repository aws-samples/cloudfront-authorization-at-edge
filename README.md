## CloudFront authorization@edge

This repo accompanies the [blog post](https://aws.amazon.com/blogs/networking-and-content-delivery/authorizationedge-using-cookies-protect-your-amazon-cloudfront-content-from-being-downloaded-by-unauthenticated-users/).

In that blog post a solution is explained, that puts **Cognito** authentication in front of (S3) downloads from **CloudFront**, using **Lambda@Edge**. **JWT's** are transferred using **cookies** to make authorization transparent to clients.

The sources in this repo implement that solution.

The purpose of this sample code is to demonstrate how Lambda@Edge can be used to implement authorization, with Cognito as identity provider (IDP). Please treat the code as an _**illustration**_––thoroughly review it and adapt it to your needs, if you want to use it for serious things.

### How to deploy

The solution can be deployed to your AWS account with a few clicks, from the [Serverless Application Repository](https://console.aws.amazon.com/lambda/home#/create/app?applicationId=arn:aws:serverlessrepo:us-east-1:520945424137:applications/cloudfront-authorization-at-edge). Note: deploy to us-east-1, as this is a requirement for Lambda@Edge (see [Deployment region](#deployment-region)).

More deployment options below: [Deploying the solution](#deploying-the-solution)

### Alternative: use HTTP headers

This repo is the "sibling" of another repo here on aws-samples ([authorization-lambda-at-edge](https://github.com/aws-samples/authorization-lambda-at-edge)). The difference is that the solution in that repo uses http headers (not cookies) to transfer JWT's. While also a valid approach, the downside of it is that your Web App (SPA) needs to be altered to pass these headers, as browsers do not send these along automatically (which they do for cookies).

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
- [static-site](src/cfn-custom-resources/static-site): A sample static site (see [SPA mode or Static Site mode?](#spa-mode-or-static-site-mode)) that is protected by the solution. The directory also contains a Lambda function that implements a CloudFormation custom resource to upload the static site to S3
- [user-pool-client](src/cfn-custom-resources/user-pool-client): Lambda function that implements a CloudFormation custom resource to update the User Pool client with OAuth config
- [user-pool-domain](src/cfn-custom-resources/user-pool-domain): Lambda function that implements a CloudFormation custom resource to lookup the User Pool's domain, at which the Hosted UI is available
- [lambda-code-update](src/cfn-custom-resources/lambda-code-update): Lambda function that implements a CloudFormation custom resource to inject configuration into the lambda@Edge functions and publish versions
- [shared](src/lambda-edge/shared): Utility functions used by several Lambda@Edge functions

Other files and directories:

- [./example-serverless-app-reuse](./example-serverless-app-reuse): Contains an example SAM template that shows how to reuse this application from the Serverless Application Repository in your own SAM templates.
- [./template.yaml](./template.yaml): The SAM template that comprises the solution
- [./webpack.config.js](./webpack.config.js): Webpack config for the Lambda@Edge functions and for the React-app custom resource
- [./tsconfig.json](./tsconfig.json): TypeScript configuration for this project

## Deploying the solution

### Option 1: Deploy through the Serverless Application Repository

The solution can be deployed with a few clicks from the [Serverless Application Repository](https://console.aws.amazon.com/lambda/home#/create/app?applicationId=arn:aws:serverlessrepo:us-east-1:520945424137:applications/cloudfront-authorization-at-edge).

### Option 2: Deploy with SAM CLI

#### Pre-requisites

1. Download and install [Node.js](https://nodejs.org/en/download/)
2. Download and install [AWS SAM CLI](https://github.com/awslabs/aws-sam-cli)
3. Of course you need an AWS account and necessary permissions to create resources in it. Make sure your AWS credentials can be found during deployment, e.g. by making your AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY available as environment variables.
4. You need an existing S3 bucket to use for the SAM deployment. Create an empty bucket.
5. Ensure your system includes a Unix-like shell such as sh, bash, zsh, etc. (i.e. Windows users: please enable/install "Linux Subsystem for Windows" or Cygwin or something similar)

NOTE: Deploy this application to region us-east-1. This is because Lambda@Edge must be deployed to us-east-1 as it is a global configuration.

#### Deployment

NOTE: Run the deployment commands below in a Unix-like shell such as sh, bash, zsh, etc. (i.e. Windows users: please run this in "Linux Subsystem for Windows" or in Cygwin or something similar)

1. Clone this repo `git clone https://github.com/aws-samples/cloudfront-authorization-at-edge`
2. Install dependencies: `npm install`
3. TypeScript compile and run Webpack: `npm run build`
4. Run SAM build. Use a container to support binaries: `sam build --use-container`
5. Run SAM package: `sam package --output-template-file packaged.yaml --s3-bucket <Your SAM bucket> --region us-east-1`
6. Run SAM deploy: `sam deploy --template-file packaged.yaml --stack-name <Your Stack Name> --capabilities CAPABILITY_IAM --parameter-overrides EmailAddress=<your email> --region us-east-1`

Providing an email address (as above in step 6) is optional. If you provide it, a user will be created in the Cognito User Pool that you can sign-in with.

### Option 3: Deploy by including the Serverless Application in your own CloudFormation template

See [./example-serverless-app-reuse](./example-serverless-app-reuse)

### Option 4: Deploy as is, then test a custom application
You may want to see how your existing application works with the authentication framework before investing the effort to integrate or automate.  One approach involves creating a full deploy from one of the deploy options above, then dropping your application into the bucket that's created.  There are a few points to be aware of:

- If you want your application to load by default instead of the sample REACT single page app (SPA), you'll need to rename the sample REACT's `index.html` and ensure your SPA entry page is named `index.html`.  The renamed sample REACT's page will still work when specifically addressed in a URL.
- It's also fine to let your SPA have its own page name, but you'll need to remember to test with its actual URL, e.g. if you drop your SPA entry page into the bucket as `myapp.html` your test URL will look like `https://SOMECLOUDFRONTURLSTRING.cloudfront.net/myapp.html`
- Make sure none of your SPA filenames collide with the REACT app.  Alternately just remove the REACT app first -- but sometimes it's nice to keep it in place to validate that authentication is generally working.

You may find that your application does not render properly -- the default Content Security Policy (CSP) in the CloudFormation parameter may be the issue.  As a quick test you can either remove the `"Content-Security-Policy":"..."` parameter from the CloudFormation's HttpHeaders parameter, or substitute your own. Leave the other headers in the parameter alone unless you have a good reason. 

## I already have a CloudFront distribution, I just want to add auth

Deploy the solution (e.g. from the [Serverless Application Repository](https://console.aws.amazon.com/lambda/home#/create/app?applicationId=arn:aws:serverlessrepo:us-east-1:520945424137:applications/cloudfront-authorization-at-edge)) while setting parameter `CreateCloudFrontDistribution` to `false`. This way, only the Lambda@Edge functions will de deployed in your account. You'll also get a User Pool and Client (unless you're [bringing your own](#i-already-have-a-cognito-user-pool-i-want-to-reuse-that-one)). Then you can wire the Lambda@Edge functions up into your own CloudFront distribution. Create a behavior for all path patterns (root, RedirectPathSignIn, RedirectPathSignOut, RedirectPathAuthRefresh, SignOutUrl) and configure the corresponding Lambda@Edge function in each behavior.

The CloudFormation Stack's Outputs contain the Lambda Version ARNs that you can refer to in your CloudFront distribution.

See this example on how to do it: [./example-serverless-app-reuse/reuse-auth-only.yaml](./example-serverless-app-reuse/reuse-auth-only.yaml)

When following this route, also provide parameter `AlternateDomainNames` upon deploying, so the correct redirect URL's can be configured for you in the Cognito User Pool Client.

## I already have an S3 bucket, I want to use that one

Go for the more barebone deployment, so you can do more yourself––i.e. reuse your bucket. Refer to scenario: [I already have a CloudFront distribution, I just want to add auth](#i-already-have-a-cloudfront-distribution-i-just-want-to-add-auth).

## I want to use another (S3 / HTTP) origin behind the CloudFront distribution

Go for the more barebone deployment, so you can do more yourself––i.e. bring your own origins. Refer to scenario: [I already have a CloudFront distribution, I just want to add auth](#i-already-have-a-cloudfront-distribution-i-just-want-to-add-auth).

## I already have a Cognito User Pool, I want to reuse that one

You can use a pre-existing Cognito User Pool (e.g. from another region), by providing the User Pool's ARN as a parameter upon deploying. Make sure you have already configured the User Pool with a domain for the Cognito Hosted UI.

In this case, also specify a pre-existing User Pool Client ID. Note that the solution's callback URLs wil be added to the User Pool Client you provide.

## I want to use a social identity provider

You should use the UserPoolGroupName parameter, to specify a group that users must be a member of in order to access the site.

Without this UserPoolGroupName, the lambda@edge functions will allow any confirmed user in the User Pool access to the site.
When an identity provider is added to the User Pool, anybody that signs in though the identity provider is immediately a confirmed user.
So with a social identity provider where anyone can create an account, this means anyone can access the site you are trying to protect.

With the UserPoolGroupName parameter defined, you will need to add each user to this group before they can access the site.

If the solution is creating the User Pool, it will create the User Pool Group too.
If the solution is creating the User Pool and a default user (via the EmailAddress parameter), then this user will be added User Pool Group.

If you are using a pre-existing User Pool, you will need to make a group that has a name matching the UserPoolGroupName.

## Deployment region

This solution contains CloudFront and Lambda@Edge resources that must be deployed to us-east-1 (but will run in all [Points of Presence](https://aws.amazon.com/cloudfront/features/#Amazon_CloudFront_Infrastructure) globally).

This solution also contains an Amazon Cognito User Pool and S3 bucket, that should ideally be deployed in a region close to your users, to keep latency low:

- You can use a pre-existing Cognito User Pool (e.g. from another region): [I already have a Cognito User Pool, I want to reuse that one](#i-already-have-a-cognito-user-pool-i-want-to-reuse-that-one)
- For S3 latency might be less of a concern than for Cognito, as your content on S3 will probably be cached at CloudFront edge locations anyway. This depends on the cache-control meta-data you set on your S3 objects. If you want to use an S3 bucket in another region, you'll have to create that yourself. In that case, go for the more barebone deployment, so you can do more yourself. Refer to scenario: [I already have a CloudFront distribution, I just want to add auth](#i-already-have-a-cloudfront-distribution-i-just-want-to-add-auth).

## SPA mode or Static Site mode?

The default deployment mode of this sample application is "SPA mode" - which entails some settings that make the deployment suitable for hosting a SPA such as a React/Angular/Vue app:

- The User Pool client does not use a client secret, as that would not make sense for JavaScript running in the browser
- The cookies with JWT's are not "http only", so that they can be read and used by the SPA (e.g. to display the user name, or to refresh tokens)
- 404's (page not found on S3) will return index.html, to enable SPA-routing

If you do not want to deploy a SPA but rather a static site, then it is more secure to use a client secret and http-only cookies. Also, SPA routing is not needed then. To this end, upon deploying, set parameter "EnableSPAMode" to false (--parameter-overrides EnableSPAMode="false"). This will:

- Enforce use of a client secret
- Set cookies to be http only by default (unless you've provided other cookie settings explicitly)
- Skip deployment of the sample React app. Rather a sample index.html is uploaded, that you can replace with your own pages
- Skip setting up the custom error document mapping 404's to index.html (404's will instead show the plain S3 404 page)

## Cookie compatibility

The cookies that this solution sets, are compatible with AWS Amplify––which makes this solution work seamlessly with AWS Amplify.

*Niche use case:*
If you want to use this solution as an Auth@Edge layer in front of AWS Elasticsearch Service with Cognito integration, you need cookies to be compatible with the cookie-naming scheme of that service. In that case, upon deploying, set parameter CookieCompatibilty to "elasticsearch".

If choosing compatibility with AWS Elasticsearch with Cognito integration:

- Set parameter EnableSPAMode to "false", because AWS Elasticsearch Cognito integration uses a client secret.
- Set parameters UserPoolArn and UserPoolClientId to the ARN and ID of the pre-existing User Pool and Client, that you've configured your Elasticsearch domain with.

## Additional Cookies

You can provide one or more additional cookies that will be set after succesfull sign-in, by setting the parameter AdditionalCookies. This may be of use to you, to dynamically provide configuration that you can read in your SPA's JavaScript.

## Contributing to this repo

If you want to contribute, please read [CONTRIBUTING](./CONTRIBUTING.md), and note the hints below.

### Declaration of npm dependencies

The sources that are not webpacked but rather run through `sam build` should have their dependencies listed in their own package.json files––to make `sam build` work properly.

For the sources that are webpacked this doesn't matter.

## License Summary

This sample code is made available under a modified MIT license. See the [LICENSE](./LICENSE) file.

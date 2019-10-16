# Protect downloads of your content hosted on CloudFront with Cognito authentication using Lambda@Edge

This serverless application accompanies the [blog post](https://aws.amazon.com/blogs/networking-and-content-delivery/authorizationedge-using-cookies-protect-your-amazon-cloudfront-content-from-being-downloaded-by-unauthenticated-users/).

In that blog post a solution is explained, that puts Cognito authentication in front of (S3) downloads from CloudFront, using Lambda@Edge. JWT's are transferred using cookies to make authorization transparent to clients.

This application is an implementation of that solution. If you deploy it, this is what you get:

- Private S3 bucket prepopulated with a sample React app. You can replace that sample app with your own Single Page Application (React, Anugular, Vue) or any other static content you want authenticated users to be able to download.
- CloudFront distribution that serves the contents of the S3 bucket
- Cognito User Pool with hosted UI set up
- Lambda@Edge functions that make sure only authenticated users can access your S3 content through CloudFront. Redirect to Cognito Hosted UI to sign-in if necessary.

If you supply an email address, a user will be created that you can use to sign-in with (a temporary password is sent to the supplied e-mail address)

To open the web app after succesful deployment, navigate to the CloudFormation stack, in the "Outputs" tab, click on the output named: "WebsiteUrl".

NOTE: Deploy this application to region us-east-1. This is because Lambda@Edge must be deployed to us-east-1 as it is a global configuration. If you want to deploy the regional services (like Cognito and the S3 bucket) to another region: that will work too, but you'll have to adapt this solution's SAM template, read more [here](./README.md#deploying-to-another-region).

NOTE: The purpose of this sample application is to demonstrate how Lambda@Edge can be used to implement authorization, with Cognito as identity provider (IDP). Please treat the application as an _**illustration**_––thoroughly review it and adapt it to your needs, if you want to use it for serious things.
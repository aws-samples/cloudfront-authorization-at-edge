The infrastructure present in this folder is meant to provide generic functionalities around the integrations between CF distributions and AWS Cognito especially with regards to the authentication.

After the application is published, one can use it inside a cloudformation template to spin-up all the resources required for running a simple authenticated cloudfront distribution of an S3 bucket.

Publishing the application is done in accordance to the (README.md) and it's explained below.

There are two variables that are important when generating the infrastructure.

- `BucketNameParameter` - override it or set it as default to target the bucket you want to use in S3. The bucket's name may be any name since we put it behind Cloudfront
- `AlternateDomainNames` - override it to specify the alternate domains you want to reach your application (since using just the cloudfront domain is usually not enough). You can safely use anything from `*.studyportals.xyz`
- `EnableSPAMode` - default true, set to 'false' to disable SPA-specific features (i.e. when deploying a static site that won't interact with logout/refresh)
  Using the edge function is only available in us-east-1 at the moment of writing this

## Deploying Infrastructure

### AWS

Run `sam build --region us-east-1` to build the infrastructure consisting of an S3 bucket, Cloudfront distribution and an authentication layer on top of it using the templates published as part of the [cloudfront-authorization-at-edge](https://github.com/dandobrescu/cloudfront-authorization-at-edge) project

Run `sam package --region us-east-1 --s3-bucket devops-sam-deployments-us-east-1 --output-template-file packaged.yaml` to prepare for deployment

Deploy it with `sam deploy --stack-name portal-experiments --region us-east-1 --capabilities CAPABILITY_IAM CAPABILITY_AUTO_EXPAND --parameter-overrides BucketNameParameter="portal-experiments" AlternateDomainNames="portal-experiments.studyportals.xyz" --s3-bucket devops-sam-deployments-us-east-1`

Take note of the `UserPoolId` and `CognitoAuthDomain` and proceed further

## Azure

Create a [new registration](https://portal.azure.com/#blade/Microsoft_AAD_RegisteredApps/ApplicationsListBlade) and set the Redirect URI to `${CognitoAuthDomain}/saml2/idpresponse` (e.g. `https://auth-cf797739.auth.us-east-1.amazoncognito.com/saml2/idpresponse`). Leave all the others to their defaults

Go to **Expose an API** and edit the Application ID URI to contain the following `urn:amazon:cognito:sp:${UserPoolId}` (e.g. `urn:amazon:cognito:sp:us-east-1_PuHwxoLbj`)

In order to also obtain the e-mail as optional claim (currently coming through name), and go to **Token Configuration**
Click `Add optional claim`, select `SAML` and then select `email`

To allow more people to login, go to the [Enterprise Applications](https://portal.azure.com/#blade/Microsoft_AAD_IAM/StartboardApplicationsMenuBlade/AllApps) and select the previously created app.
Click on `User and Groups` and then `Add User`. Select the `Engineering` group if you wish to make the app available for all engineers all otherwise adjust your IAM constraints to the appropiate list of users/groups. Finish by clicking assign.

:warning: The publish operatoin requires administrative privileges.

## Create DNS Record for the chosen alternate domain

Setup the alternate domain DNS name in Cloudflare using the Cloudflare's distrubtion endpoint as CNAME

## Using the app

Start from an an example [Aperture Science Enrichment Center](https://github.com/studyportals/Aperture-Science-Enrichment-Center/blob/master/Dockerfile) or [Knowledge Vault](https://github.com/studyportals/knowledge-Vault/blob/master/Dockerfile) or place the following in your cloudformation template:

```yaml  LambdaEdgeProtection:
Type: AWS::Serverless::Application
Properties:
  Location:
    ApplicationId: arn:aws:serverlessrepo:us-east-1:478262784215:applications/cloudfront-authorization-at-edge
    SemanticVersion: 1.4.3
  Parameters:
    CreateCloudFrontDistribution: true
    HttpHeaders: !Ref HttpHeaders
    AlternateDomainNames: !Join [",", !Ref AlternateDomainNames]
```

The `SemanticVersion` may take any values from the [application's published versions](https://console.aws.amazon.com/serverlessrepo/home?region=us-east-1#/published-applications/arn:aws:serverlessrepo:us-east-1:478262784215:applications~cloudfront-authorization-at-edge)

## Extending the edge functions

See the [Knowledge Vault](https://github.com/studyportals/knowledge-Vault/) project for an example about how to add your own `origin-request` function

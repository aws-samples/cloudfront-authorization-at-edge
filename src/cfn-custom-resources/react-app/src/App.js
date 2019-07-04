// Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import React, { useState, useEffect } from 'react';
import Amplify from '@aws-amplify/core';
import Auth from '@aws-amplify/auth';
import './App.css';

Amplify.configure({
  Auth: {
    region: 'us-east-1',
    userPoolId: process.env.REACT_APP_USER_POOL_ID,
    userPoolWebClientId: process.env.REACT_APP_USER_POOL_WEB_CLIENT_ID,
    cookieStorage: {
      path: '/',
      expires: '',
      domain: window.location.hostname,
      secure: true,
    },
    oauth: {
      domain: process.env.REACT_APP_USER_POOL_AUTH_DOMAIN,
      scope: process.env.REACT_APP_USER_POOL_SCOPES.split(','),
      redirectSignIn: `https://${window.location.hostname}${process.env.REACT_APP_USER_POOL_REDIRECT_PATH_SIGN_IN}`,
      redirectSignOut: `https://${window.location.hostname}${process.env.REACT_APP_USER_POOL_REDIRECT_PATH_SIGN_OUT}`,
      responseType: 'code'
    }
  }
});

const decodeToken = (token) => {
  const tokenBody = token.split('.')[1];
  const decodableTokenBody = tokenBody.replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(window.atob(decodableTokenBody));
}

const App = () => {

  const [state, setState] = useState({
    email: undefined,
    username: undefined,
  });

  useEffect(() => {
    Auth.currentSession()
      .then(user => setState({
        username: user.username,
        email: decodeToken(user.getIdToken().getJwtToken()).email,
      }));
    // Schedule check and refresh (when needed) of JWT's every 5 min:
    const i = setInterval(() => Auth.currentSession(), 5 * 60 * 1000);
    return () => clearInterval(i);
  }, []);

  return (
    <div className="App">
      <h1>Private</h1>

      <p className="explanation">Welcome <strong>{state.email || state.username}</strong>. You are signed in!</p>

      <p className="explanation">
        If you are able to come here, it means everything was deployed in order. Amongst other things, you've deployed a CloudFront distribution
        that you're viewing right now.
      </p>

      <h4>What just happened:</h4>

      <ol className="explanation-points">
        <li>You just signed-in at the Cognito Hosted UI. You were redirected there by a Lambda@Edge function; it detected you had not yet authenticated.</li>
        <li>After sign-in you were redirected back by Cognito to your Cloudfront distribution. Another
          Lambda@Edge function handled that redirect and traded the authorization code for JWT's and stored these in your cookies.</li>
        <li>After that, the Lambda@Edge redirected you back to the URL you originally requested. This time you have valid JWT's in your cookies so you
          were allowed access, and here you are.</li>
      </ol>

      <h3>Good job!</h3>

      <p className="explanation">
        The page you're viewing right now is served from S3 (through CloudFront). You can upload your own SPA (React, Angular, Vue, ...) to the S3 bucket instead
        and thus instantly secure it with Cognito authentication.
        If your SPA uses AWS Amplify framework with cookie storage for Auth, the detection of the sign-in status in the SPA will work seamlessly,
        because the Lambda@Edge setup uses the same cookies. Of course your SPA needs to be made aware of the right&nbsp;
          <span className="config">config
            <span className="config-text">
            {`Amplify.configure({
  Auth: {
    region: "us-east-1",
    userPoolId: "${process.env.REACT_APP_USER_POOL_ID}",
    userPoolWebClientId: "${process.env.REACT_APP_USER_POOL_WEB_CLIENT_ID}",
    cookieStorage: {
      path: "/",
      expires: "",
      domain: "${window.location.hostname}",
      secure: true,
    },
    oauth: {
      domain: "${process.env.REACT_APP_USER_POOL_AUTH_DOMAIN}",
      scope: ${JSON.stringify(process.env.REACT_APP_USER_POOL_SCOPES.split(','))},
      redirectSignIn: "https://${window.location.hostname}${process.env.REACT_APP_USER_POOL_REDIRECT_PATH_SIGN_IN}",
      redirectSignOut: "https://${window.location.hostname}${process.env.REACT_APP_USER_POOL_REDIRECT_PATH_SIGN_OUT}",
      responseType: "code"
    }
  }
});`}
          </span>
        </span>.
        </p>

      <p className="explanation">
        Take a look at your cookies (open the developer panel in your browser) and you'll see a couple of JWT's there. Try clearing these cookies
        and reload the page, then you'll have to sign in again––unless you are still signed in at the Cognito hosted UI, in which case you would be
        redirected back here seamlessly with new JWT's.
        </p>

      <p className="explanation">
        To sign-out both locally (by clearing cookies) as well as at the Cognito hosted UI, use the sign-out button: <button onClick={() => Auth.signOut()}>Sign out</button>.
        That uses Amplify to sign out. Alternatively, sign out using Lambda@Edge by explicitly visiting the sign-out URL: <a href={process.env.REACT_APP_SIGN_OUT_URL}>Sign Out</a>.
      </p>

      <p className="explanation">
        Now that you're signed in, you can access any file in the protected S3 bucket, directly through the URL. For example,
          open this AWS SAM introduction image: <a href="aws_sam_introduction.png" target="_blank">link</a>. If you open the link, your browser will automatically send the
cookies along, allowing Cloudfront Lambda@Edge to inspect and validate them, and only return you that image if the JWT's in your cookies are indeed
still valid. Try clearing your cookies again and then open the link, Lambda@Edge will then redirect you to the Cognito hosted UI. After sign-in
there (you may still be signed in there) you will be redirected back to the link location.
        </p>
    </div>
  );
}

export default App;

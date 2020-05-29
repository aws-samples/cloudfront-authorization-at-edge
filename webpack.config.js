const path = require('path');
const TerserPlugin = require('terser-webpack-plugin');

module.exports = {
  mode: 'production',
  target: 'node',
  node: {
    __dirname: false
  },
  entry: {
    'src/lambda-edge/parse-auth/bundle': path.resolve(__dirname, './src/lambda-edge/parse-auth/index.ts'),
    'src/lambda-edge/check-auth/bundle': path.resolve(__dirname, './src/lambda-edge/check-auth/index.ts'),
    'src/lambda-edge/refresh-auth/bundle': path.resolve(__dirname, './src/lambda-edge/refresh-auth/index.ts'),
    'src/lambda-edge/http-headers/bundle': path.resolve(__dirname, './src/lambda-edge/http-headers/index.ts'),
    'src/lambda-edge/sign-out/bundle': path.resolve(__dirname, './src/lambda-edge/sign-out/index.ts'),
    'src/cfn-custom-resources/react-app/bundle': path.resolve(__dirname, './src/cfn-custom-resources/react-app/index.ts'),
    'src/cfn-custom-resources/static-site/bundle': path.resolve(__dirname, './src/cfn-custom-resources/static-site/index.ts'),
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        use: 'ts-loader',
        exclude: /node_modules/
      },
      {
        test: /\.html$/i,
        loader: 'html-loader',
        options: {
          minimize: true,
        },
      },
    ]
  },
  resolve: {
    extensions: [ '.ts', '.js' ]
  },
  output: {
    path: path.resolve(__dirname),
    filename: '[name].js',
    libraryTarget: 'commonjs',
  },
  externals: [
    /^aws-sdk/ // Don't include the aws-sdk in bundles as it is already present in the Lambda runtime
  ],
  performance: {
    hints: 'error',
    maxAssetSize: 1048576, // Max size of deployment bundle in Lambda@Edge Viewer Request
    maxEntrypointSize: 1048576, // Max size of deployment bundle in Lambda@Edge Viewer Request
  },
  optimization: {
    minimizer: [new TerserPlugin({
      cache: true,
      parallel: true,
      extractComments: true,
    })],
  },
}

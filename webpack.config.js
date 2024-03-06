const path = require("path");
const fs = require("fs");
const TerserPlugin = require("terser-webpack-plugin");

function generateConfig(baseDir, baseConfig) {
  return fs
    .readdirSync(baseDir, { withFileTypes: true })
    .filter((dirent) => dirent.isDirectory())
    .map((dirent) => path.join(baseDir, dirent.name))
    .filter((dirPath) => fs.existsSync(path.join(dirPath, "package.json")))
    .reduce((acc, dirPath) => {
      acc.push({
        ...baseConfig,
        entry: `${path.resolve(dirPath, "index.ts")}`,
        output: {
          filename: "bundle.js",
          libraryTarget: "commonjs",
          path: path.resolve(dirPath),
        },
      });
      return acc;
    }, []);
}

const baseConfig = {
  mode: "production",
  target: "node",
  node: {
    __dirname: false,
  },
  resolve: {
    extensions: [".ts", ".js"],
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        loader: "ts-loader",
        exclude: /node_modules/,
      },
    ],
  },
  optimization: {
    minimizer: [
      new TerserPlugin({
        parallel: true,
        extractComments: true,
      }),
    ],
  },
  stats: {
    errorDetails: true,
  },
};

const lambdaEdgeBaseConfig = {
  ...baseConfig,
  module: {
    rules: [
      ...baseConfig.module.rules,
      {
        test: /\.html$/i,
        loader: "html-loader",
        options: {
          minimize: true,
        },
      },
    ],
  },
  performance: {
    hints: "error",
    maxAssetSize: 1048576, // Max size of deployment bundle in Lambda@Edge Viewer Request
    maxEntrypointSize: 1048576, // Max size of deployment bundle in Lambda@Edge Viewer Request
  },
};

const customResourceBaseConfig = {
  ...baseConfig,
  ignoreWarnings: [/original-fs/],
};

module.exports = [
  ...generateConfig(
    path.resolve(__dirname, "src/lambda-edge"),
    lambdaEdgeBaseConfig
  ),
  ...generateConfig(
    path.resolve(__dirname, "src/cfn-custom-resources"),
    customResourceBaseConfig
  ),
];

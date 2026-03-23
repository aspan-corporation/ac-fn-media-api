#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { AcFnMediaApiStack } from "../lib/ac-fn-media-api-stack.js";

const app = new cdk.App();
new AcFnMediaApiStack(app, "AcFnMediaApiStack", {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION }
});

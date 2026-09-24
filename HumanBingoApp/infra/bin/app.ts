#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { HumanBingoStack } from '../lib/human-bingo-stack.js';

const app = new cdk.App();
const account = process.env.CDK_DEFAULT_ACCOUNT;
const region = process.env.CDK_DEFAULT_REGION;

new HumanBingoStack(app, 'HumanBingoStack', {
  ...(account && region ? { env: { account, region } } : {}),
});

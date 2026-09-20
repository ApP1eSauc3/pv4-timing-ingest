#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { Pv4TimingStack } from '../lib/pv4-timing-stack';

const app = new cdk.App();

// Tag everything so `aws resourcegroupstaggingapi get-resources
// --tag-filters Key=project,Values=pv4` lists exactly what this stack owns.
// This account runs other workloads.
cdk.Tags.of(app).add('project', 'pv4');

new Pv4TimingStack(app, 'Pv4TimingStack', {
  // Resolved from the CLI credentials at synth time. Never hardcode the account
  // id — this repo is public.
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});

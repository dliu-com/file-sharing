#!/usr/bin/env node
import 'source-map-support/register';
import { App, Tags } from 'aws-cdk-lib';
import { FileSharingStack } from '../lib/file-sharing-stack';
import site from '../config/site.json';

const region = process.env.CDK_DEFAULT_REGION || 'eu-west-1';
// Imports the MainDomain and traffic-monitor exports, which live in eu-west-1 with the other site stacks.
// The Lambda@Edge function goes into a separate stack in us-east-1, which CDK creates and deploys with this one.
if (region !== 'eu-west-1') throw new Error('FileSharing must be deployed to eu-west-1, alongside the other site stacks.');

const app = new App();
for (const [key, value] of Object.entries({ service: 'file-sharing', Project: 'share.dliu.com' })) Tags.of(app).add(key, value);
new FileSharingStack(app, 'FileSharing', {
  subdomain: site.subdomain,
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region },
});

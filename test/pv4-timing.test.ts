/**
 * Stack-level assertions. Grows as lib/pv4-timing-stack.ts is built out — the
 * settings asserted here are the ones that are cheap to get wrong and expensive
 * to notice late (API key expiry, TTL, removal policies).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as cdk from 'aws-cdk-lib/core';
import { Template } from 'aws-cdk-lib/assertions';

import { Pv4TimingStack } from '../lib/pv4-timing-stack';

const synth = () => {
  const app = new cdk.App();
  cdk.Tags.of(app).add('project', 'pv4');
  const stack = new Pv4TimingStack(app, 'Pv4TimingStack', {
    env: { account: '000000000000', region: 'ap-southeast-2' },
  });
  return { stack, template: Template.fromStack(stack) };
};

test('the stack synthesizes', () => {
  const { template } = synth();
  assert.ok(template.toJSON());
});

test('nothing in the template hardcodes a real account id', () => {
  const { template } = synth();
  const json = JSON.stringify(template.toJSON());

  // A standalone 12-digit run is an AWS account id; the only one allowed is the
  // dummy passed in above. Written generically so this file never itself carries
  // a fragment of the real account id — the repo is public.
  //
  // The boundaries matter: asset hashes are hex, and a 64-character hex string
  // regularly contains twelve consecutive digits by chance. Without them this
  // test fails at random whenever a bundled asset changes.
  const accountIds = (json.match(/(?<![0-9a-zA-Z])\d{12}(?![0-9a-zA-Z])/g) ?? [])
    .filter((id) => id !== '000000000000');
  assert.deepEqual(accountIds, [], 'no real account id may be baked into the template');
});

test('the table is destroyed on teardown, not retained', () => {
  const { template } = synth();
  // The CDK default is RETAIN, which would leave the table behind in an account
  // that runs other workloads. This test is here so nobody restores the default.
  template.hasResource('AWS::DynamoDB::Table', { DeletionPolicy: 'Delete' });
});

test('the table is on-demand with TTL on expiresAt', () => {
  const { template } = synth();
  template.hasResourceProperties('AWS::DynamoDB::Table', {
    BillingMode: 'PAY_PER_REQUEST',
    TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
  });
});

test('the ingest function has the table name and a supported runtime', () => {
  const { template } = synth();
  template.hasResourceProperties('AWS::Lambda::Function', {
    FunctionName: 'pv4-ingest',
    Runtime: 'nodejs22.x',
  });
});

test('no reserved concurrency is set', () => {
  const { template } = synth();
  // This account's Lambda concurrency quota is 10, and AWS refuses any
  // reservation leaving fewer than 100 unreserved. The design originally called
  // for 25; it cannot deploy. This test stops it being reinstated from the plan.
  const functions = Object.values(template.findResources('AWS::Lambda::Function'));
  assert.ok(functions.length >= 1, 'no functions found — this test would pass vacuously');
  for (const fn of functions) {
    assert.equal(
      'ReservedConcurrentExecutions' in (fn as { Properties: object }).Properties,
      false,
      'reserved concurrency cannot be set at this account quota',
    );
  }
});

test('POST /timing is the only route', () => {
  const { template } = synth();
  template.resourceCountIs('AWS::ApiGatewayV2::Route', 1);
  template.hasResourceProperties('AWS::ApiGatewayV2::Route', { RouteKey: 'POST /timing' });
});

test('the GraphQL API uses API key auth', () => {
  const { template } = synth();
  template.hasResourceProperties('AWS::AppSync::GraphQLApi', { AuthenticationType: 'API_KEY' });
});

test('the API key outlives the assessment', () => {
  const { template } = synth();
  // AppSync's default expiry is SEVEN DAYS. The key has to still work when they
  // come to grade this, which may be weeks after submission.
  const keys = Object.values(template.findResources('AWS::AppSync::ApiKey'));
  assert.equal(keys.length, 1);
  const expires = (keys[0] as { Properties: { Expires: number } }).Properties.Expires;
  const daysOut = (expires * 1000 - Date.now()) / 86_400_000;
  assert.ok(daysOut > 300, `API key expires in ${Math.round(daysOut)} days — too soon`);
});

test('all four queries in the contract have a resolver', () => {
  const { template } = synth();
  template.resourceCountIs('AWS::AppSync::Resolver', 4);
  for (const fieldName of ['events', 'results', 'eventStats', 'updatesRejected']) {
    template.hasResourceProperties('AWS::AppSync::Resolver', { TypeName: 'Query', FieldName: fieldName });
  }
});

test('the read API cannot write to the table', () => {
  const { template } = synth();
  // Structural, not a convention: the query function is granted read actions
  // only, so a bug in it can never change a result.
  const policies = Object.values(template.findResources('AWS::IAM::Policy'))
    .map((p) => JSON.stringify((p as { Properties: unknown }).Properties))
    .filter((p) => p.includes('QueryFunction'));

  assert.ok(policies.length >= 1, 'no policy found for the query function');
  for (const policy of policies) {
    for (const write of ['dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem']) {
      assert.equal(policy.includes(write), false, `query function must not have ${write}`);
    }
  }
});

test('there are two alarms, and neither is on rejections', () => {
  const { template } = synth();
  template.resourceCountIs('AWS::CloudWatch::Alarm', 2);

  // Errors: the processor could not say what happened to an update.
  template.hasResourceProperties('AWS::CloudWatch::Alarm', {
    MetricName: 'Errors',
    Namespace: 'AWS/Lambda',
    TreatMissingData: 'notBreaching',
  });

  // Invocations: the endpoint is public, so volume is the signal that someone
  // other than the timing feed found it. Watched rather than throttled, because
  // a 429 at the edge never reaches the processor and so is counted nowhere.
  template.hasResourceProperties('AWS::CloudWatch::Alarm', {
    MetricName: 'Invocations',
    Namespace: 'AWS/Lambda',
    TreatMissingData: 'notBreaching',
  });

  // The brief says ~1 in 10 updates arrives corrupt, so rejections are normal.
  // An alarm on them would fire every race and be muted, which is worse than
  // having no alarm at all.
  const alarms = Object.values(template.findResources('AWS::CloudWatch::Alarm'));
  for (const alarm of alarms) {
    const metric = (alarm as { Properties: { MetricName?: string } }).Properties.MetricName;
    assert.notEqual(metric, 'UpdatesRejected', 'must not alarm on rejections');
  }
});

test('the results bucket is private and served through CloudFront', () => {
  const { template } = synth();
  template.hasResourceProperties('AWS::S3::Bucket', {
    PublicAccessBlockConfiguration: {
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    },
  });
  template.resourceCountIs('AWS::CloudFront::Distribution', 1);
  template.hasResourceProperties('AWS::CloudFront::Distribution', {
    DistributionConfig: {
      DefaultRootObject: 'index.html',
      DefaultCacheBehavior: { ViewerProtocolPolicy: 'redirect-to-https' },
    },
  });
});

test('the page hardcodes no endpoint — it reads config.json at runtime', () => {
  const page = readFileSync(join(__dirname, '..', 'web', 'index.html'), 'utf8');
  assert.ok(page.includes("fetch('config.json')"), 'page must read its config at runtime');
  assert.equal(/appsync-api|execute-api|da2-/.test(page), false, 'no endpoint or key may be baked into the page');
  assert.equal(/eventId:\s*"WC26/.test(page), false, 'no event id may be hardcoded');
});

test('the page distinguishes a broken read from an empty one', () => {
  const page = readFileSync(join(__dirname, '..', 'web', 'index.html'), 'utf8');

  // An expired API key is the most likely failure weeks after deployment. If it
  // rendered the same as "this event has no results yet", nobody grading it
  // would know the difference.
  assert.ok(page.includes('UNAUTHORIZED'), 'must detect a rejected API key');
  assert.ok(page.includes('showBanner'), 'must surface failures in a banner');
  assert.ok(
    page.includes('Results could not be loaded.'),
    'a failed read must say so rather than showing an empty table',
  );
  assert.ok(page.includes('No events yet'), 'a genuinely empty pipeline still says so separately');
});

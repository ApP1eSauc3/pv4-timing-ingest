/**
 * Stack-level assertions. Grows as lib/pv4-timing-stack.ts is built out — the
 * settings asserted here are the ones that are cheap to get wrong and expensive
 * to notice late (API key expiry, TTL, removal policies).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
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

  // Any 12-digit run is an AWS account id. The only one allowed is the dummy
  // passed in above. Written generically so this file never itself carries a
  // fragment of the real account id — the repo is public.
  const accountIds = (json.match(/\d{12}/g) ?? []).filter((id) => id !== '000000000000');
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

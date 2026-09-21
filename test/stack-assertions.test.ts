/**
 * Fine-grained assertion tests.
 *
 * The snapshot catches every change; these say which changes matter and why.
 * Each one pins a decision that is cheap to get wrong and expensive to notice
 * late - a permission widening, a key layout changing, an output disappearing
 * from the submission.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import * as cdk from 'aws-cdk-lib/core';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';

import { Pv4TimingStack } from '../lib/pv4-timing-stack';

const build = () => {
  const app = new cdk.App();
  cdk.Tags.of(app).add('project', 'pv4');
  const stack = new Pv4TimingStack(app, 'Pv4TimingStack', {
    env: { account: '000000000000', region: 'ap-southeast-2' },
  });
  return { stack, template: Template.fromStack(stack) };
};

test('the table key layout is PK/SK strings', () => {
  const { template } = build();
  // The whole design depends on counters and athletes sharing a partition.
  template.hasResourceProperties('AWS::DynamoDB::Table', {
    KeySchema: [
      { AttributeName: 'PK', KeyType: 'HASH' },
      { AttributeName: 'SK', KeyType: 'RANGE' },
    ],
  });
});

test('both Lambdas are told which table to use', () => {
  const { template } = build();
  const functions = template.findResources('AWS::Lambda::Function');
  const named = Object.values(functions).filter((fn) =>
    ['pv4-ingest', 'pv4-query'].includes((fn as { Properties: { FunctionName?: string } }).Properties.FunctionName ?? ''),
  );
  assert.equal(named.length, 2, 'expected the ingest and query functions');
  for (const fn of named) {
    const env = (fn as { Properties: { Environment?: { Variables?: Record<string, unknown> } } }).Properties.Environment;
    assert.ok(env?.Variables?.TABLE_NAME, 'TABLE_NAME must be set');
  }
});

test('only the ingest function may write to the table', () => {
  const { template } = build();
  const policies = Object.values(template.findResources('AWS::IAM::Policy'));

  const writes = ['dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem'];
  const writers = policies.filter((p) => {
    const json = JSON.stringify((p as { Properties: unknown }).Properties);
    return writes.some((action) => json.includes(action));
  });

  assert.equal(writers.length, 1, 'exactly one policy should carry table write permissions');
  assert.ok(
    JSON.stringify((writers[0] as { Properties: unknown }).Properties).includes('IngestFunction'),
    'the writer must be the ingest function',
  );
});

test('every alarm notifies an SNS topic', () => {
  const { template } = build();
  template.resourceCountIs('AWS::SNS::Topic', 1);

  // An alarm with no action is a light nobody is looking at. Asserted for every
  // alarm rather than for one of them, so adding a third cannot quietly ship
  // without a destination.
  const alarms = Object.values(template.findResources('AWS::CloudWatch::Alarm'));
  assert.ok(alarms.length >= 1, 'no alarms found — this test would pass vacuously');

  for (const alarm of alarms) {
    const { AlarmName, AlarmActions } = (
      alarm as { Properties: { AlarmName?: string; AlarmActions?: unknown[] } }
    ).Properties;
    assert.ok(
      AlarmActions && AlarmActions.length > 0,
      `${AlarmName ?? 'an alarm'} has no alarm action`,
    );
  }
});

test('the four resolvers all use the query Lambda as their data source', () => {
  const { template } = build();
  template.resourceCountIs('AWS::AppSync::DataSource', 1);
  template.hasResourceProperties('AWS::AppSync::DataSource', { Type: 'AWS_LAMBDA' });

  const resolvers = Object.values(template.findResources('AWS::AppSync::Resolver'));
  assert.equal(resolvers.length, 4);
  for (const resolver of resolvers) {
    const props = (resolver as { Properties: { TypeName: string; DataSourceName: unknown } }).Properties;
    assert.equal(props.TypeName, 'Query');
    assert.ok(props.DataSourceName, 'every resolver needs a data source');
  }
});

test('the results bucket is encrypted and refuses plain HTTP', () => {
  const { template } = build();
  template.hasResourceProperties('AWS::S3::Bucket', {
    BucketEncryption: Match.objectLike({
      ServerSideEncryptionConfiguration: Match.arrayWith([
        Match.objectLike({ ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }),
      ]),
    }),
  });
  template.hasResourceProperties('AWS::S3::BucketPolicy', {
    PolicyDocument: Match.objectLike({
      Statement: Match.arrayWith([Match.objectLike({ Condition: { Bool: { 'aws:SecureTransport': 'false' } } })]),
    }),
  });
});

test('every URL the submission asks for is a stack output', () => {
  const { template } = build();
  // These four are what gets pasted into the submission email. If one is
  // dropped, it is found weeks later while hunting through the console.
  for (const output of ['IngestUrl', 'GraphqlUrl', 'GraphqlApiKey', 'ResultsPageUrl']) {
    template.hasOutput(output, Match.objectLike({ Value: Match.anyValue() }));
  }
});

test('logs are kept for a week, not forever and not by default', () => {
  const { template } = build();
  const groups = Object.values(template.findResources('AWS::Logs::LogGroup'));
  assert.equal(groups.length, 2, 'one log group per function');
  for (const group of groups) {
    assert.equal((group as { Properties: { RetentionInDays?: number } }).Properties.RetentionInDays, 7);
  }
});

test('the stack synthesizes with no CDK errors or warnings', () => {
  const { stack } = build();
  // Validation-style check: CDK reports construct-level problems as annotations
  // rather than exceptions, so without this they synthesize silently. This is
  // what would catch a deprecated property or a misconfigured construct.
  Annotations.fromStack(stack).hasNoError('*', Match.anyValue());
  Annotations.fromStack(stack).hasNoWarning('*', Match.anyValue());
});

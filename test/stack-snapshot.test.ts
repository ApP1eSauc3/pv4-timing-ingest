/**
 * Snapshot test.
 *
 * The coarsest of the three kinds of CDK test: it fails on ANY change to the
 * synthesized template, which is the point. An assertion test only catches what
 * it was told to look at; this catches the change nobody thought to assert on -
 * a removal policy flipping, a permission widening, a resource disappearing.
 *
 * Asset hashes are scrubbed first. They change whenever a source file changes,
 * so leaving them in would break this test on every edit to src/ and train
 * whoever sees it to re-record without reading the diff.
 *
 * Re-record deliberately with: npm run snapshot
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as cdk from 'aws-cdk-lib/core';
import { Template } from 'aws-cdk-lib/assertions';

import { Pv4TimingStack } from '../lib/pv4-timing-stack';

const SNAPSHOT = join(__dirname, '__snapshots__', 'Pv4TimingStack.json');

/** Strip anything that changes without the infrastructure changing. */
function scrub(template: object): object {
  return JSON.parse(
    JSON.stringify(template)
      // S3 keys for bundled Lambda assets: a hex hash plus .zip
      .replace(/[0-9a-f]{64}\.zip/g, '<asset>.zip')
      // The asset bucket name carries the account id
      .replace(/cdk-[0-9a-z]+-assets-\d{12}-[a-z0-9-]+/g, '<assets-bucket>')
      // API key expiry is "now + 365 days", so it moves every synth
      .replace(/"Expires":\s*\d+/g, '"Expires": "<epoch>"'),
  );
}

export function currentTemplate(): object {
  const app = new cdk.App();
  cdk.Tags.of(app).add('project', 'pv4');
  const stack = new Pv4TimingStack(app, 'Pv4TimingStack', {
    env: { account: '000000000000', region: 'ap-southeast-2' },
  });
  return scrub(Template.fromStack(stack).toJSON());
}

test('the synthesized template matches the recorded snapshot', () => {
  const template = currentTemplate();

  if (!existsSync(SNAPSHOT)) {
    writeFileSync(SNAPSHOT, `${JSON.stringify(template, null, 2)}\n`);
    console.log('snapshot recorded for the first time');
    return;
  }

  const recorded = JSON.parse(readFileSync(SNAPSHOT, 'utf8'));
  assert.deepEqual(
    template,
    recorded,
    'the stack no longer matches its snapshot. If the change is intended, re-record with `npm run snapshot` and read the diff before committing it.',
  );
});

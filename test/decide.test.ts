/**
 * These tests are RED until src/decide.ts is implemented. That is intentional:
 * they are the specification of the ordering rule, written from the brief's
 * worked example before the code.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { decide } from '../src/decide';
import { workedExample } from './fixtures';

test('the brief\'s six-row worked example, in arrival order', () => {
  let stored: number | undefined;
  const outcomes: string[] = [];

  for (const row of workedExample) {
    const decision = decide(stored, row.revision);
    assert.equal(
      decision,
      row.expect,
      `arrival ${row.arrives} (revision ${row.revision} ${row.status}): expected ${row.expect} — ${row.why}`,
    );
    if (decision === 'APPLY') stored = row.revision;
    outcomes.push(decision);
  }

  assert.equal(stored, 4, 'final state must be revision 4');
  assert.equal(outcomes.filter((o) => o === 'APPLY').length, 3, 'three accepted');
  assert.equal(outcomes.filter((o) => o === 'IGNORE').length, 3, 'three ignored');
});

test('a new athlete is always applied', () => {
  assert.equal(decide(undefined, 1), 'APPLY');
  assert.equal(decide(undefined, 9), 'APPLY');
});

test('an exact duplicate is ignored', () => {
  assert.equal(decide(3, 3), 'IGNORE');
});

test('a stale revision is ignored', () => {
  assert.equal(decide(3, 2), 'IGNORE');
  assert.equal(decide(3, 1), 'IGNORE');
});

test('a higher revision is applied', () => {
  assert.equal(decide(3, 4), 'APPLY');
  assert.equal(decide(1, 100), 'APPLY', 'gaps in the revision sequence are fine');
});

test('status is not an input — decide() takes only revisions', () => {
  assert.equal(decide.length, 2, 'adding a status parameter would break the ordering rule');
});

test('every shuffle of a revision history ends at the maximum revision', () => {
  const revisions = [1, 2, 3, 4, 5, 6];

  const permute = (xs: number[]): number[][] =>
    xs.length <= 1 ? [xs] : xs.flatMap((x, i) => permute([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));

  for (const order of permute(revisions)) {
    let stored: number | undefined;
    let accepted = 0;
    let ignored = 0;

    for (const revision of order) {
      if (decide(stored, revision) === 'APPLY') {
        stored = revision;
        accepted += 1;
      } else {
        ignored += 1;
      }
    }

    assert.equal(stored, 6, `order ${order.join(',')} must end at revision 6`);
    assert.equal(accepted + ignored, order.length, 'every update lands in exactly one bucket');
  }
});

test('duplicates never inflate the accepted count', () => {
  const arrivals = [1, 1, 2, 2, 2, 3, 3];
  let stored: number | undefined;
  let accepted = 0;

  for (const revision of arrivals) {
    if (decide(stored, revision) === 'APPLY') {
      stored = revision;
      accepted += 1;
    }
  }

  assert.equal(accepted, 3, 'three distinct revisions, seven arrivals');
  assert.equal(stored, 3);
});

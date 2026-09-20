import test from 'node:test';
import assert from 'node:assert/strict';

import { MAX_BODY_BYTES, validateBody, validateUpdate } from '../src/validate';
import { corruptVariants, update, wellFormed } from './fixtures';

test('the brief\'s well-formed update is valid, field for field', () => {
  const result = validateUpdate(wellFormed);
  assert.equal(result.valid, true);
  assert.deepEqual(result.valid && result.update, {
    eventId: 'WC26-ATH-M100M-SF2',
    bib: 'AUS-1147',
    lane: 3,
    revision: 2,
    status: 'CONFIRMED',
    timeMs: 10105,
    recordedAt: '2026-08-25T19:42:07.000Z',
  });
});

test('all three statuses are accepted, and nothing else is', () => {
  for (const status of ['PROVISIONAL', 'CONFIRMED', 'OFFICIAL'] as const) {
    assert.equal(validateUpdate(update(1, status)).valid, true, status);
  }
});

for (const variant of corruptVariants) {
  test(`corrupt: ${variant.name}`, () => {
    const result = validateUpdate(variant.body);
    assert.equal(result.valid, false, 'should have been rejected');
    assert.ok(
      !result.valid && result.failedChecks.includes(variant.failedCheck as never),
      `expected ${variant.failedCheck}, got ${!result.valid && result.failedChecks.join(',')}`,
    );
  });
}

test('every failing check is reported, not just the first', () => {
  const result = validateUpdate({ eventId: '', bib: '', lane: 'x', revision: 0, status: 'nope', timeMs: -1 });
  assert.equal(result.valid, false);
  assert.equal(!result.valid && result.failedChecks.length, 6);
});

test('recordedAt is never validated — a nonsense clock still passes', () => {
  assert.equal(validateUpdate(update(1, 'OFFICIAL', { recordedAt: 'not-a-date' })).valid, true);
  assert.equal(validateUpdate(update(1, 'OFFICIAL', { recordedAt: undefined })).valid, true);
});

test('unknown extra fields do not make a payload corrupt', () => {
  const result = validateUpdate(update(1, 'OFFICIAL', { splitTimes: [1, 2], windSpeed: 0.4 }));
  assert.equal(result.valid, true);
  assert.equal(result.valid && 'splitTimes' in result.update, false, 'extras are dropped, not stored');
});

test('10105.0 is indistinguishable from 10105 once parsed, so it is accepted', () => {
  assert.equal(validateBody(JSON.stringify({ ...wellFormed, timeMs: 10105.0 })).valid, true);
});

test('non-object bodies are corrupt', () => {
  for (const body of ['null', '[]', '"a string"', '42', '{]', '']) {
    assert.equal(validateBody(body).valid, false, body);
  }
  assert.equal(validateBody(undefined).valid, false);
});

test('an oversized body is rejected before it is parsed', () => {
  const huge = JSON.stringify({ ...wellFormed, padding: 'x'.repeat(MAX_BODY_BYTES) });
  const result = validateBody(huge);
  assert.equal(result.valid, false);
  assert.deepEqual(!result.valid && result.failedChecks, ['body_withinSizeLimit']);
});

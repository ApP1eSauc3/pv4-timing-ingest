/**
 * Fixtures taken verbatim from the brief. The worked example is the contract:
 * if these six rows do not behave exactly as the table says, the submission is
 * wrong regardless of what any other test claims.
 */

import type { ResultStatus } from '../src/types';

export const EVENT_ID = 'WC26-ATH-M100M-SF2';
export const BIB = 'AUS-1147';

export type RawUpdate = Record<string, unknown>;

export const wellFormed: RawUpdate = {
  eventId: EVENT_ID,
  bib: BIB,
  lane: 3,
  revision: 2,
  status: 'CONFIRMED',
  timeMs: 10105,
  recordedAt: '2026-08-25T19:42:07.000Z',
};

export const update = (revision: number, status: ResultStatus, over: RawUpdate = {}): RawUpdate => ({
  ...wellFormed,
  revision,
  status,
  ...over,
});

/**
 * The brief's worked example, in arrival order.
 * Three accepted, three ignored, final state revision 4 PROVISIONAL.
 */
export const workedExample: {
  arrives: number;
  revision: number;
  status: ResultStatus;
  expect: 'APPLY' | 'IGNORE';
  why: string;
}[] = [
  { arrives: 1, revision: 1, status: 'PROVISIONAL', expect: 'APPLY', why: 'new athlete' },
  { arrives: 2, revision: 3, status: 'OFFICIAL', expect: 'APPLY', why: '3 > 1' },
  { arrives: 3, revision: 2, status: 'CONFIRMED', expect: 'IGNORE', why: '2 is not greater than 3' },
  { arrives: 4, revision: 3, status: 'OFFICIAL', expect: 'IGNORE', why: 'duplicate of revision 3' },
  { arrives: 5, revision: 3, status: 'CONFIRMED', expect: 'IGNORE', why: 'not greater, whatever status' },
  { arrives: 6, revision: 4, status: 'PROVISIONAL', expect: 'APPLY', why: 'jury reopened the result' },
];

/** One corrupt variant per field rule in the brief's table. */
export const corruptVariants: { name: string; body: RawUpdate; failedCheck: string }[] = [
  { name: 'eventId missing', body: update(2, 'CONFIRMED', { eventId: undefined }), failedCheck: 'eventId_nonEmptyString' },
  { name: 'eventId empty', body: update(2, 'CONFIRMED', { eventId: '' }), failedCheck: 'eventId_nonEmptyString' },
  { name: 'eventId whitespace', body: update(2, 'CONFIRMED', { eventId: '   ' }), failedCheck: 'eventId_nonEmptyString' },
  { name: 'eventId not a string', body: update(2, 'CONFIRMED', { eventId: 42 }), failedCheck: 'eventId_nonEmptyString' },
  { name: 'bib missing', body: update(2, 'CONFIRMED', { bib: undefined }), failedCheck: 'bib_nonEmptyString' },
  { name: 'bib null', body: update(2, 'CONFIRMED', { bib: null }), failedCheck: 'bib_nonEmptyString' },
  { name: 'lane missing', body: update(2, 'CONFIRMED', { lane: undefined }), failedCheck: 'lane_int32' },
  { name: 'lane fractional', body: update(2, 'CONFIRMED', { lane: 3.5 }), failedCheck: 'lane_int32' },
  { name: 'lane as string', body: update(2, 'CONFIRMED', { lane: '3' }), failedCheck: 'lane_int32' },
  { name: 'revision zero', body: update(0, 'CONFIRMED'), failedCheck: 'revision_int32Gte1' },
  { name: 'revision negative', body: update(-1, 'CONFIRMED'), failedCheck: 'revision_int32Gte1' },
  { name: 'revision fractional', body: update(2.5, 'CONFIRMED'), failedCheck: 'revision_int32Gte1' },
  { name: 'revision as string', body: update(2, 'CONFIRMED', { revision: '2' }), failedCheck: 'revision_int32Gte1' },
  { name: 'revision above int32', body: update(2, 'CONFIRMED', { revision: 2_147_483_648 }), failedCheck: 'revision_int32Gte1' },
  { name: 'status lowercase', body: update(2, 'CONFIRMED', { status: 'official' }), failedCheck: 'status_knownValue' },
  { name: 'status unknown', body: update(2, 'CONFIRMED', { status: 'RATIFIED' }), failedCheck: 'status_knownValue' },
  { name: 'status missing', body: update(2, 'CONFIRMED', { status: undefined }), failedCheck: 'status_knownValue' },
  { name: 'timeMs zero', body: update(2, 'CONFIRMED', { timeMs: 0 }), failedCheck: 'timeMs_int32Positive' },
  { name: 'timeMs negative', body: update(2, 'CONFIRMED', { timeMs: -10105 }), failedCheck: 'timeMs_int32Positive' },
  { name: 'timeMs fractional', body: update(2, 'CONFIRMED', { timeMs: 10105.5 }), failedCheck: 'timeMs_int32Positive' },
  { name: 'timeMs above int32', body: update(2, 'CONFIRMED', { timeMs: 2_147_483_648 }), failedCheck: 'timeMs_int32Positive' },
];

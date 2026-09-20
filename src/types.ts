/**
 * Shared types for the timing processor.
 *
 * recordedAt is carried through and stored, but never validated and never used
 * for ordering: it comes from timing hardware whose clock is not trustworthy.
 */

export const RESULT_STATUSES = ['PROVISIONAL', 'CONFIRMED', 'OFFICIAL'] as const;

export type ResultStatus = (typeof RESULT_STATUSES)[number];

/** A timing update that has passed every validation check. */
export type TimingUpdate = {
  eventId: string;
  bib: string;
  lane: number;
  revision: number;
  status: ResultStatus;
  timeMs: number;
  recordedAt?: unknown;
};

/** The name of one validation rule, stored on a rejection so it explains
 *  itself later. */
export type CheckName =
  | 'body_withinSizeLimit'
  | 'body_isJson'
  | 'body_isObject'
  | 'eventId_nonEmptyString'
  | 'bib_nonEmptyString'
  | 'lane_int32'
  | 'revision_int32Gte1'
  | 'status_knownValue'
  | 'timeMs_int32Positive';

export type ValidationResult =
  | { valid: true; update: TimingUpdate }
  | { valid: false; failedChecks: CheckName[] };

/** What the processor did with an update. Every update lands in exactly one -
 *  the invariant this design is built around. */
export type Outcome = 'ACCEPTED' | 'IGNORED' | 'REJECTED';

/** What eventStats returns. Every field is non-null in the schema, so each is a
 *  real number even when nothing has happened yet. */
export type EventStatsShape = {
  eventId: string;
  athletesTracked: number;
  updatesAccepted: number;
  updatesIgnored: number;
};

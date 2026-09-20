/**
 * Validation, the third rule and the one that keeps the other two honest.
 *
 * Pure code with no SDK imports and no I/O. All of it runs before any write,
 * which is what guarantees a corrupt payload cannot create a phantom athlete who
 * was never in the race.
 *
 * Strict by construction: a field counts as valid only if it is positively
 * valid, never merely present. `"3"`, `3.5`, `"official"`, `null` and a missing
 * field are all corrupt, and treating them as anything else would mean guessing
 * on behalf of a timing system I cannot ask.
 */

import { RESULT_STATUSES, type CheckName, type ResultStatus, type TimingUpdate, type ValidationResult } from './types';

/**
 * Bodies above this are rejected before anything tries to parse them. JSON.parse
 * costs time in proportion to a body the feed controls, and a misbehaving rig
 * can happily send megabytes. API Gateway (10 MB) and Lambda (6 MB) both cap
 * above this, and anything they turn away never reaches us at all, so it cannot
 * be counted - which I have written up as a concession rather than hidden.
 */
export const MAX_BODY_BYTES = 64 * 1024;

/**
 * GraphQL's Int is a signed 32-bit integer, so anything larger would break the
 * read contract their harness runs against. I would rather call that corrupt on
 * the way in than discover it as an error on the way out.
 */
const INT32_MAX = 2_147_483_647;
const INT32_MIN = -2_147_483_648;

const isInt32 = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= INT32_MIN && v <= INT32_MAX;

/** Non-empty after trimming, so an id of pure whitespace cannot create an athlete. */
const isNonEmptyString = (v: unknown): v is string =>
  typeof v === 'string' && v.trim().length > 0;

const isResultStatus = (v: unknown): v is ResultStatus =>
  typeof v === 'string' && (RESULT_STATUSES as readonly string[]).includes(v);

/**
 * Validates an already-parsed body, collecting every failing check rather than
 * stopping at the first one. Consequently a stored rejection explains everything
 * that was wrong with it, not just whichever rule happened to be tested first.
 */
export function validateUpdate(raw: unknown): ValidationResult {
  const failedChecks: CheckName[] = [];

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { valid: false, failedChecks: ['body_isObject'] };
  }

  const body = raw as Record<string, unknown>;

  if (!isNonEmptyString(body.eventId)) failedChecks.push('eventId_nonEmptyString');
  if (!isNonEmptyString(body.bib)) failedChecks.push('bib_nonEmptyString');
  if (!isInt32(body.lane)) failedChecks.push('lane_int32');
  if (!isInt32(body.revision) || body.revision < 1) failedChecks.push('revision_int32Gte1');
  if (!isResultStatus(body.status)) failedChecks.push('status_knownValue');
  if (!isInt32(body.timeMs) || body.timeMs <= 0) failedChecks.push('timeMs_int32Positive');

  if (failedChecks.length > 0) return { valid: false, failedChecks };

  // Unknown extra fields are accepted and then dropped. The brief defines
  // corruption field by field, so an extra one does not make a payload corrupt.
  // recordedAt is carried straight through without being validated.
  return {
    valid: true,
    update: {
      eventId: (body.eventId as string).trim(),
      bib: (body.bib as string).trim(),
      lane: body.lane as number,
      revision: body.revision as number,
      status: body.status as ResultStatus,
      timeMs: body.timeMs as number,
      recordedAt: body.recordedAt,
    },
  };
}

/**
 * Size check, then parse, then validate, and the order genuinely matters. The
 * size check is the only one that happens before we spend any time at all on
 * input somebody else controls.
 */
export function validateBody(rawBody: string | undefined | null): ValidationResult {
  if (rawBody == null || rawBody.length === 0) {
    return { valid: false, failedChecks: ['body_isJson'] };
  }
  if (Buffer.byteLength(rawBody, 'utf8') > MAX_BODY_BYTES) {
    return { valid: false, failedChecks: ['body_withinSizeLimit'] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { valid: false, failedChecks: ['body_isJson'] };
  }

  return validateUpdate(parsed);
}

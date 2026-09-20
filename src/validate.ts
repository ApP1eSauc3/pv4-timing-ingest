/**
 * Validation — processor rule 3.
 *
 * Pure: no SDK imports, no I/O. Everything here runs before any write, so a
 * corrupt payload can never create a phantom athlete who was never in the race.
 *
 * Strict by construction: a field is valid only if it is positively valid.
 * `"3"`, `3.5`, `"official"`, `null` and a missing field are all corrupt.
 */

import { RESULT_STATUSES, type CheckName, type ResultStatus, type TimingUpdate, type ValidationResult } from './types';

/**
 * Reject a body larger than this before parsing it. `JSON.parse` costs time
 * linear in a body the feed controls, and a misbehaving rig can send megabytes.
 * API Gateway (10 MB) and Lambda (6 MB) cap above this; anything they reject
 * never reaches us and cannot be counted (a concession in DECISIONS.md).
 */
export const MAX_BODY_BYTES = 64 * 1024;

/**
 * GraphQL `Int` is a signed 32-bit integer. A larger value would break the read
 * contract the harness runs against, so it is corrupt on the way in rather than
 * an error on the way out.
 */
const INT32_MAX = 2_147_483_647;
const INT32_MIN = -2_147_483_648;

const isInt32 = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= INT32_MIN && v <= INT32_MAX;

/** Non-empty after trimming, so a whitespace-only id cannot create an athlete. */
const isNonEmptyString = (v: unknown): v is string =>
  typeof v === 'string' && v.trim().length > 0;

const isResultStatus = (v: unknown): v is ResultStatus =>
  typeof v === 'string' && (RESULT_STATUSES as readonly string[]).includes(v);

/**
 * Validate an already-parsed body. Collects *every* failing check rather than
 * stopping at the first, so a stored rejection says all of what was wrong.
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

  // Unknown extra fields are accepted and dropped — they do not make a payload
  // corrupt. `recordedAt` is carried through unvalidated.
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
 * Size-check, then parse, then validate. The order matters: the size check is
 * the only one that runs before we spend time on attacker-controlled input.
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

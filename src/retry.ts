/**
 * The retry policy, in one place.
 *
 * Every write here eventually touches a row other writes are also touching - a
 * per-event counter, or the pipeline-wide rejected counter. Each one left
 * without a retry produced 5xx responses under load, in three different files,
 * which is why the policy lives here and every writer shares it.
 *
 * A collision is never a verdict about revisions. It means another writer was
 * touching the row, and the answer is always to try again.
 */

import { TransactionCanceledException, TransactionConflictException } from '@aws-sdk/client-dynamodb';

export const MAX_ATTEMPTS = 8;
const BASE_BACKOFF_MS = 25;

/**
 * Capped at 200 ms. Uncapped, eight doublings reach 3.2 s on the last attempt
 * alone and threaten the Lambda's 10 s timeout - and a timeout returns 5xx
 * without any classification running. Capped, the sequence is ~1.2 s worst case.
 *
 * The jitter is not decoration: without it, two writers that collide retry in
 * lockstep and collide again.
 */
const BACKOFF_CAP_MS = 200;

export const backoffFor = (attempt: number) =>
  Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), BACKOFF_CAP_MS) + Math.random() * BASE_BACKOFF_MS;

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Capacity and collision faults. None of them says anything about revisions. */
export const RETRYABLE = new Set([
  'TransactionConflict',
  'ThrottlingError',
  'ProvisionedThroughputExceeded',
]);

/**
 * A collision, however DynamoDB reports it - and it reports the same thing three
 * ways: its own exception class, a reason inside a cancelled transaction, or a
 * throttling error known only by name.
 */
export function isContention(error: unknown): boolean {
  if (error instanceof TransactionConflictException) return true;

  if (error instanceof TransactionCanceledException) {
    return (error.CancellationReasons ?? []).some((reason) => reason.Code && RETRYABLE.has(reason.Code));
  }

  const name = (error as { name?: string })?.name ?? '';
  return RETRYABLE.has(name) || name === 'ThrottlingException' || name === 'ProvisionedThroughputExceededException';
}

/**
 * For writes with no condition, where a collision is the only thing that can go
 * wrong and there is nothing to classify. Anything else is rethrown: a failed
 * write swallowed here becomes a wrong number somewhere else.
 */
export async function withContentionRetry<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (isContention(error) && attempt < MAX_ATTEMPTS) {
        await sleep(backoffFor(attempt));
        continue;
      }
      throw error;
    }
  }
}

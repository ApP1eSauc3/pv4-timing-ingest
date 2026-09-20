/**
 * Retrying contention, in one place.
 *
 * Every write in this system eventually touches a row that other writes are also
 * touching — a per-event counter, or the pipeline-wide rejected counter. Each
 * time one of those was left without a retry it produced 5xx responses under
 * load, three separate times, in three different files. So the policy lives here
 * and every writer uses it.
 *
 * Contention is never a verdict about revisions. It says only "someone else was
 * touching this row" and the correct response is always to try again.
 */

import { TransactionCanceledException, TransactionConflictException } from '@aws-sdk/client-dynamodb';

export const MAX_ATTEMPTS = 8;
const BASE_BACKOFF_MS = 25;

/**
 * Capped at 200 ms. Uncapped, eight doublings would reach 3.2 s on the final
 * attempt alone and threaten the Lambda's 10 s timeout — and a timeout returns
 * 5xx without any classification running at all. Capped, the whole sequence is
 * ~1.2 s worst case.
 *
 * The jitter is not decoration: without it two writers that collide retry in
 * lockstep and collide again.
 */
const BACKOFF_CAP_MS = 200;

export const backoffFor = (attempt: number) =>
  Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), BACKOFF_CAP_MS) + Math.random() * BASE_BACKOFF_MS;

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Capacity and contention faults. None of them say anything about revisions. */
export const RETRYABLE = new Set([
  'TransactionConflict',
  'ThrottlingError',
  'ProvisionedThroughputExceeded',
]);

/**
 * Contention, however DynamoDB chooses to report it — and it reports it three
 * different ways: as its own exception class, as a reason inside a cancelled
 * transaction, or as a throttling error by name.
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
 * For writes with no condition on them, where contention is the only thing that
 * can go wrong and there is nothing to classify. Anything else is rethrown
 * immediately — a failed write must never be swallowed.
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

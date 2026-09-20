/**
 * Retrying collisions, kept in one place.
 *
 * Every write here eventually touches a row that other writes are also touching,
 * whether that is a per-event counter or the pipeline-wide rejected counter.
 * Each time I left one of those without a retry it produced 5xx responses under
 * load - three separate times, in three different files, before I stopped
 * patching call sites and moved the policy here where every writer shares it.
 *
 * A collision is never a verdict about revisions. It only ever means "someone
 * else was touching this row at that moment", and the right answer is always to
 * wait a moment and try again.
 */

import { TransactionCanceledException, TransactionConflictException } from '@aws-sdk/client-dynamodb';

export const MAX_ATTEMPTS = 8;
const BASE_BACKOFF_MS = 25;

/**
 * Capped at 200 ms. Left uncapped, eight doublings would reach 3.2 s on the last
 * attempt alone and start threatening the Lambda's 10 s timeout, and a timeout
 * hands back a 5xx without any of the classification running at all. Capped, the
 * whole sequence comes in around 1.2 s at worst.
 *
 * The jitter is not decoration either. Without it, two writers that collide go
 * away and come back in lockstep, and collide all over again.
 */
const BACKOFF_CAP_MS = 200;

export const backoffFor = (attempt: number) =>
  Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), BACKOFF_CAP_MS) + Math.random() * BASE_BACKOFF_MS;

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Capacity and collision faults. Not one of them says anything about revisions. */
export const RETRYABLE = new Set([
  'TransactionConflict',
  'ThrottlingError',
  'ProvisionedThroughputExceeded',
]);

/**
 * A collision, however DynamoDB has chosen to report it this time - and it
 * reports the same thing three different ways: as its own exception class, as a
 * reason buried inside a cancelled transaction, or as a throttling error known
 * only by its name.
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
 * For writes that carry no condition, where a collision is the only thing that
 * can really go wrong and there is nothing to classify afterwards. Anything else
 * is rethrown straight away, because a failed write that gets swallowed here
 * becomes a wrong number somewhere else.
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

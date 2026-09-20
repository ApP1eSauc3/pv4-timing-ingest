/**
 * The valid path — where an update is either applied or ignored.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * DELIBERATELY UNIMPLEMENTED — write this by hand. Delete this banner when done.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Everything around this function is finished: the handler decodes, validates,
 * and handles the reject path. This is the last piece, and it is the piece the
 * interview will spend its time on.
 *
 * What it must do:
 *
 * 1. One `TransactWriteCommand` with three items:
 *      - Update `resultKey(eventId, bib)` with the new lane/revision/status/
 *        timeMs, conditional on:
 *            attribute_not_exists(revision) OR revision < :rev
 *      - Update `statsKey(eventId)`: ADD updatesAccepted 1
 *      - Update `eventRegistryKey(eventId)`:
 *            SET firstSeenAt = if_not_exists(firstSeenAt, :now)
 *
 *    Note: `revision` and `status` are DynamoDB reserved words, so they need
 *    ExpressionAttributeNames. One operation per item per transaction.
 *
 *    ⚠ The registry write must be an Update with if_not_exists, never a Put
 *    conditional on attribute_not_exists(PK). A conditional Put fails the whole
 *    transaction on every update after an event's first — and that failure looks
 *    exactly like a stale revision, so it would be miscounted as "ignored",
 *    silently. A single-update test still passes.
 *
 * 2. If the transaction succeeds, return 'ACCEPTED'.
 *
 * 3. If it throws `TransactionCanceledException`, read `CancellationReasons`.
 *    It is **positional**: entry 0 is the result Update, entry 1 is STATS,
 *    entry 2 is the registry, in the order you listed them. The only condition
 *    in this transaction is on the result item, so a failed condition is
 *    `CancellationReasons[0].Code` and the other two will read 'None'. Read
 *    index 0 directly rather than scanning for the first non-'None' code —
 *    under load every update touches STATS, so a scan would sometimes pick up a
 *    conflict from a different item and attribute it to the revision check.
 *
 *    One exception, several very different meanings:
 *
 *      ConditionalCheckFailed   The revision was not greater. A duplicate or a
 *                               stale update. Increment updatesIgnored on
 *                               statsKey(eventId), then return 'IGNORED'.
 *
 *      TransactionConflict      Another writer touched the item at that instant.
 *                               Says NOTHING about the revision. Retry with
 *                               jittered backoff, 3 attempts, then throw.
 *
 *      ThrottlingError,         Capacity. Retry, then throw.
 *      ProvisionedThroughputExceeded
 *
 *      anything else            Throw.
 *
 *    Get this wrong and you cause the exact failure the brief is about: revision
 *    4 loses a conflict, is misread as "ignored", and the result sticks at
 *    revision 3 forever — a jury reopening that never reaches the scoreboard.
 *    The SDK does not retry cancellations for you.
 *
 *    Budget: the Lambda times out at 10 s and the HTTP API's integration
 *    timeout is 30 s and cannot be raised. Keep three attempts of jittered
 *    backoff in the low hundreds of milliseconds — seconds-scale backoff would
 *    hit the Lambda timeout, which returns a 5xx *without* your classification
 *    ever running.
 *
 * 4. Never swallow a write error. Anything that is not a failed condition must
 *    throw so the handler returns 5xx and the feed re-sends. A failed write
 *    counted as "ignored" is a silently wrong number.
 *
 * Note on the ignored path: the counter is a second call, after the condition
 * fails. If the Lambda dies between the two, the feed retries, the condition
 * fails again and it is counted once. Under a crash with no retry the ignored
 * count is short by one — a known concession, already in DECISIONS.md §1.
 *
 * Do NOT call `decide()` here. It is the model of this rule, not the
 * enforcement. Deciding in JavaScript would mean reading before writing, and
 * two Lambdas on the same bib could then both read revision 3 and both write.
 * The condition is what makes that impossible.
 */

import type { TimingUpdate } from './types';

export async function applyValid(
  _update: TimingUpdate,
  _requestId: string,
): Promise<'ACCEPTED' | 'IGNORED'> {
  throw new Error('applyValid() not implemented — see the contract above');
}

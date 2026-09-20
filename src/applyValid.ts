/**
 * The valid path: apply an update, or count it as ignored.
 *
 * Both rules come down to one condition on one write:
 *
 *   attribute_not_exists(#revision) OR #revision < :rev
 *
 * Condition holds, the update is newer and overwrites. Condition fails, what is
 * stored was already at least as new - which is what a duplicate and a late
 * arrival both look like. One line, two rules, no separate dedupe.
 *
 * The condition never mentions status. That is what lets revision 4 PROVISIONAL
 * replace revision 3 OFFICIAL when a jury upholds a protest.
 *
 * decide() states the same rule as a pure function and is tested against every
 * arrival order, but it is not called here. Deciding in JavaScript means reading
 * before writing, and two Lambdas on the same athlete could both read revision 3
 * and both write. Only the database can settle that.
 */

import { TransactionCanceledException, TransactionConflictException } from '@aws-sdk/client-dynamodb';
import { TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

import { ddb, eventRegistryKey, resultKey, statsShardKey, TABLE_NAME } from './db';
import { backoffFor, MAX_ATTEMPTS, RETRYABLE, sleep, withContentionRetry } from './retry';
import type { TimingUpdate } from './types';


export async function applyValid(
  update: TimingUpdate,
  _requestId: string,
): Promise<'ACCEPTED' | 'IGNORED'> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await ddb.send(new TransactWriteCommand({ TransactItems: buildTransaction(update) }));
      return 'ACCEPTED';
    } catch (error) {
      // DynamoDB reports collisions through two different exception types. This
      // one is not a cancelled transaction: it is raised when the item is
      // already inside another in-flight transaction. It says nothing about
      // revisions, so retry it and never count it.
      if (error instanceof TransactionConflictException) {
        if (attempt < MAX_ATTEMPTS) {
          await sleep(backoffFor(attempt));
          continue;
        }
        throw error;
      }

      // Anything else is an infrastructure problem, not a verdict on this
      // update, so it goes straight up. A failed write recorded as "ignored" is
      // a number that balances and is wrong.
      if (!(error instanceof TransactionCanceledException)) throw error;

      const reasons = error.CancellationReasons ?? [];

      // CancellationReasons is positional: [0] result, [1] counter, [2]
      // registry. Only the result carries a condition, so a failed condition can
      // only appear at [0]. Read that index directly rather than scanning: every
      // update touches the counter, so a scan would eventually pick up a
      // collision at [1] and blame the revision check for it.
      if (reasons[0]?.Code === 'ConditionalCheckFailed') {
        await countIgnored(update.eventId);
        return 'IGNORED';
      }

      // A collision means two writers reached the same row at once. It says
      // nothing about which revision is newer. Counting it as "ignored" would
      // strand the result at an old revision permanently - a jury reopening that
      // never reaches the scoreboard.
      const retryable = reasons.some((reason) => reason.Code && RETRYABLE.has(reason.Code));
      if (retryable && attempt < MAX_ATTEMPTS) {
        await sleep(backoffFor(attempt));
        continue;
      }

      // Out of attempts, or cancelled for a reason not accounted for. Throw:
      // the handler returns 5xx, the feed re-sends, nothing is counted.
      throw error;
    }
  }
}

/**
 * All three writes land together or none do, so a result cannot be applied
 * without being counted and no crash leaves the two disagreeing.
 */
function buildTransaction(update: TimingUpdate) {
  const now = new Date().toISOString();

  // All aliased. `status` has to be - DynamoDB reserves it - and aliasing the
  // rest costs nothing.
  const names: Record<string, string> = {
    '#bib': 'bib',
    '#lane': 'lane',
    '#revision': 'revision',
    '#status': 'status',
    '#timeMs': 'timeMs',
    '#updatedAt': 'updatedAt',
  };

  const values: Record<string, unknown> = {
    ':bib': update.bib,
    ':lane': update.lane,
    ':rev': update.revision,
    ':status': update.status,
    ':timeMs': update.timeMs,
    ':now': now,
    // No ':one' here. These values belong to the result update, which never
    // references it, and DynamoDB rejects the whole transaction if a declared
    // value goes unused. The counter declares its own.
  };

  const setParts = [
    '#bib = :bib',
    '#lane = :lane',
    '#revision = :rev',
    '#status = :status',
    '#timeMs = :timeMs',
    '#updatedAt = :now',
  ];

  // Stored as received, never validated and never ordered on - the timing
  // hardware's clock is not trustworthy. Only written when present, so the
  // expression never references a value that does not exist.
  if (update.recordedAt !== undefined) {
    names['#recordedAt'] = 'recordedAt';
    values[':recordedAt'] = update.recordedAt;
    setParts.push('#recordedAt = :recordedAt');
  }

  return [
    {
      Update: {
        TableName: TABLE_NAME,
        Key: resultKey(update.eventId, update.bib),
        UpdateExpression: `SET ${setParts.join(', ')}`,

        // Both rules, one line. No mention of status.
        ConditionExpression: 'attribute_not_exists(#revision) OR #revision < :rev',
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      },
    },
    {
      Update: {
        TableName: TABLE_NAME,
        Key: statsShardKey(update.eventId),
        UpdateExpression: 'ADD updatesAccepted :one',
        ExpressionAttributeValues: { ':one': 1 },
      },
    },
    {
      // Update with if_not_exists, never a Put conditional on the key not
      // existing. That version fails the transaction on every update after an
      // event's first, and the failure is indistinguishable from a stale
      // revision - so it would be counted as "ignored" while a single-update
      // test still passes.
      Update: {
        TableName: TABLE_NAME,
        Key: eventRegistryKey(update.eventId),
        UpdateExpression: 'SET firstSeenAt = if_not_exists(firstSeenAt, :now)',
        ExpressionAttributeValues: { ':now': now },
      },
    },
  ];
}

/**
 * A second call, because the transaction it belonged to has already been
 * cancelled. If the Lambda dies between the two, the feed re-sends, the
 * condition fails again and the update is counted once. The gap is a crash with
 * no re-send, where the ignored count comes up one short - recorded as a
 * concession in DECISIONS.md.
 *
 * It needs the same retry as the transaction, for the same reason: it writes to
 * a counter row every other update is also writing to. Measured - with no retry
 * here, 33 of 200 updates returned 5xx at five concurrent requests.
 */
async function countIgnored(eventId: string): Promise<void> {
  await withContentionRetry(() =>
    ddb.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: statsShardKey(eventId),
        UpdateExpression: 'ADD updatesIgnored :one',
        ExpressionAttributeValues: { ':one': 1 },
      }),
    ),
  );
}


/**
 * The valid path, where an update is either applied or counted as ignored.
 *
 * Both of the first two rules come down to a single condition on a single write:
 *
 *   attribute_not_exists(#revision) OR #revision < :rev
 *
 * If that holds, the update is genuinely newer information and it overwrites
 * what is stored. If it fails, then whatever is already in the table was at
 * least as new, which is exactly what a duplicate and a late arrival both look
 * like from here. Ultimately, one line covers two rules, and I think that is the
 * most interesting thing about this design.
 *
 * Notice what the condition never mentions: status. That is deliberate, and it
 * is what allows a revision 4 PROVISIONAL to replace a revision 3 OFFICIAL when
 * a jury upholds a protest, rather than the system quietly refusing to let a
 * ratified result be reopened.
 *
 * `decide()` says the same thing as a pure function and is tested against every
 * possible arrival order, but I deliberately do not call it here. Deciding in
 * JavaScript would mean reading before writing, and two Lambdas handling the
 * same athlete could then both read revision 3 and both write. Only the database
 * can settle a race like that, so the database is where the decision lives.
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
      // Something that caught me out: DynamoDB reports contention through two
      // completely different exception types, and this one is not a cancelled
      // transaction at all. It is raised when the item is already inside another
      // in-flight transaction. Either way it tells us nothing about revisions,
      // so it gets retried and never counted.
      if (error instanceof TransactionConflictException) {
        if (attempt < MAX_ATTEMPTS) {
          await sleep(backoffFor(attempt));
          continue;
        }
        throw error;
      }

      // Anything that is not a cancelled transaction is an infrastructure
      // problem, not a verdict about this update, so it goes straight up. A
      // failed write recorded as "ignored" would be a number that looks right
      // and is wrong, which is the worst outcome available here.
      if (!(error instanceof TransactionCanceledException)) throw error;

      const reasons = error.CancellationReasons ?? [];

      // CancellationReasons lines up with the items in the order they were
      // listed: [0] is the result, [1] is the counter, [2] is the registry. The
      // only condition in this transaction is on the result, so a failed
      // condition can only ever appear at [0]. Consequently I read that index
      // directly instead of scanning for the first thing that went wrong -
      // under load every update touches the counter, so a scan would eventually
      // pick up a collision there and blame the revision check for it.
      if (reasons[0]?.Code === 'ConditionalCheckFailed') {
        await countIgnored(update.eventId);
        return 'IGNORED';
      }

      // A collision just means two writers reached the same row at the same
      // instant. It says nothing whatsoever about which revision is newer, and
      // treating it as "ignored" would strand a result at an old revision
      // permanently - a jury reopening that never reaches the scoreboard, which
      // is the exact failure this whole system exists to prevent.
      const retryable = reasons.some((reason) => reason.Code && RETRYABLE.has(reason.Code));
      if (retryable && attempt < MAX_ATTEMPTS) {
        await sleep(backoffFor(attempt));
        continue;
      }

      // Out of attempts, or cancelled for a reason I have not accounted for.
      // Throwing hands back a 5xx and the feed re-sends, which is the honest
      // answer: we do not know what happened, so nothing gets counted.
      throw error;
    }
  }
}

/**
 * All three writes land together or none of them do. Effectively this means a
 * result can never be applied without also being counted, and no crash can leave
 * the stored state and the counters telling different stories.
 */
function buildTransaction(update: TimingUpdate) {
  const now = new Date().toISOString();

  // Every attribute is aliased. `status` has to be, since DynamoDB reserves it,
  // and aliasing the rest costs nothing while removing the question entirely.
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
    // No ':one' here, and this one cost me a deploy. These values belong to the
    // result update, which never references it, and DynamoDB rejects the entire
    // transaction if a declared value goes unused. The counter declares its own.
  };

  const setParts = [
    '#bib = :bib',
    '#lane = :lane',
    '#revision = :rev',
    '#status = :status',
    '#timeMs = :timeMs',
    '#updatedAt = :now',
  ];

  // Stored exactly as it arrived, never validated and never ordered on, because
  // the brief is clear that the timing hardware's clock cannot be trusted. Only
  // written when it is actually there, so the expression never points at a value
  // that does not exist.
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

        // Both rules, one line, and no mention of status anywhere in it.
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
      // An update with if_not_exists, never a Put conditional on the key not
      // existing. That version fails the whole transaction on every update after
      // an event's first, and the failure is indistinguishable from a stale
      // revision, so it would quietly be counted as "ignored" - while a test
      // that sends a single update still passes. A nasty one to find later.
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
 * This has to be a second call, since the transaction it would have belonged to
 * has already been cancelled. If the Lambda dies between the two, the feed
 * re-sends, the condition fails again and the update still ends up counted once.
 * The gap is a crash with no re-send at all, where the ignored count comes up
 * one short - a concession I have written up rather than pretended away.
 *
 * It needs the same retry as the transaction above, for the same reason: it
 * writes to a counter row that every other update is also writing to. I found
 * that the hard way. With no retry here, 33 of 200 updates came back as 5xx at
 * only five concurrent requests, even though the transaction itself was already
 * retrying perfectly well.
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


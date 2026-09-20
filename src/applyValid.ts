/**
 * The valid path: apply an update, or record that it was ignored.
 *
 * Rules 1 and 2 (idempotency and ordering) are both enforced by one condition
 * on one write:
 *
 *   attribute_not_exists(#revision) OR #revision < :rev
 *
 * If that condition holds the update is newer information and is applied. If it
 * fails, the stored revision was already at least as new, which is what both a
 * duplicate and a late arrival look like. `status` is never consulted, so a
 * revision 4 PROVISIONAL correctly replaces a revision 3 OFFICIAL when a jury
 * reopens a result.
 *
 * `decide()` states the same rule as a pure function and is tested exhaustively,
 * but it is deliberately not called here. Deciding in JavaScript would mean
 * reading before writing, and two Lambdas handling the same bib could then both
 * read revision 3 and both write. Only the store can settle that.
 */

import { TransactionCanceledException, TransactionConflictException } from '@aws-sdk/client-dynamodb';
import { TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

import { ddb, eventRegistryKey, resultKey, statsShardKey, TABLE_NAME } from './db';
import { backoffFor, MAX_ATTEMPTS, RETRYABLE, sleep, withContentionRetry } from './retry';
import type { TimingUpdate } from './types';

/**
 * Eight attempts, backoff capped at 200 ms, is ~1.2 s worst case. The
 * Lambda times out at 10 s and the HTTP API's integration timeout is 30 s and
 * cannot be raised, so this has to stay well inside that: a timeout returns 5xx
 * without any of the classification below ever running.
 *
 * Three attempts was the first guess and it was not enough. Every update for an
 * event increments the same STATS item, so concurrent updates contend on that
 * one row even when they concern different athletes. Measured: at five requests
 * in flight, three attempts left 20 of 200 updates failing.
 */




export async function applyValid(
  update: TimingUpdate,
  _requestId: string,
): Promise<'ACCEPTED' | 'IGNORED'> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await ddb.send(new TransactWriteCommand({ TransactItems: buildTransaction(update) }));
      return 'ACCEPTED';
    } catch (error) {
      // DynamoDB reports contention through TWO different exception types, and
      // this one is not a cancellation at all: it is raised when the item is
      // already inside another in-flight transaction. It says nothing about
      // revisions, so it is retried, never counted.
      if (error instanceof TransactionConflictException) {
        if (attempt < MAX_ATTEMPTS) {
          await sleep(backoffFor(attempt));
          continue;
        }
        throw error;
      }

      // Anything that is not a cancelled transaction is an infrastructure
      // failure. It must never be counted as "ignored" — a failed write recorded
      // as a domain outcome is a silently wrong number.
      if (!(error instanceof TransactionCanceledException)) throw error;

      const reasons = error.CancellationReasons ?? [];

      // CancellationReasons is positional: [0] is the result update, [1] is the
      // stats counter, [2] is the event registry. Only [0] carries a condition,
      // so a failed condition can only appear there. Reading index 0 directly
      // rather than scanning matters under load — every update touches the same
      // STATS item, so a scan would sometimes find a conflict at [1] and
      // mistake it for a stale revision.
      if (reasons[0]?.Code === 'ConditionalCheckFailed') {
        await countIgnored(update.eventId);
        return 'IGNORED';
      }

      // A conflict means two writers touched an item at the same instant. It
      // says NOTHING about which revision is newer. Treating it as "ignored"
      // would leave a result stuck at an old revision permanently, which is
      // exactly the failure this system exists to prevent.
      // Note the position: a conflict usually appears at index 1, the shared
      // STATS item, not at index 0. Every update for an event touches that one
      // row, so it is the most contended item in the table by a wide margin.
      const retryable = reasons.some((reason) => reason.Code && RETRYABLE.has(reason.Code));
      if (retryable && attempt < MAX_ATTEMPTS) {
        await sleep(backoffFor(attempt));
        continue;
      }

      // Out of attempts, or cancelled for a reason we do not understand. Throw,
      // so the handler returns 5xx and the feed re-sends. Nothing is counted.
      throw error;
    }
  }
}

/**
 * All three writes, or none of them. A result can never be applied without
 * being counted, and a crash cannot leave the two disagreeing.
 */
function buildTransaction(update: TimingUpdate) {
  const now = new Date().toISOString();

  // Every attribute is aliased. `status` is a DynamoDB reserved word, and
  // aliasing the rest costs nothing and removes the question entirely.
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
    // NOTE: no ':one' here. These values belong to the result update, which does
    // not reference it. DynamoDB rejects the whole transaction if any declared
    // value is unused by its expression. The stats item declares its own.
  };

  const setParts = [
    '#bib = :bib',
    '#lane = :lane',
    '#revision = :rev',
    '#status = :status',
    '#timeMs = :timeMs',
    '#updatedAt = :now',
  ];

  // Stored as received, never validated and never ordered on — the timing
  // hardware's clock is not trustworthy. Only written when it is actually
  // present, so the expression never references a value that does not exist.
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

        // Rules 1 and 2, in one line. Never looks at status.
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
      // Update with if_not_exists, never a Put conditional on
      // attribute_not_exists(PK). A conditional Put fails the whole transaction
      // on every update after an event's first, and that failure is
      // indistinguishable from a stale revision — so it would be counted as
      // "ignored", silently, while a single-update test still passed.
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
 * A second call, because the transaction it belongs to has already been
 * cancelled. If the Lambda dies between the two, the feed retries, the condition
 * fails again and the update is counted once. Under a crash with no retry the
 * ignored count is short by one — the concession recorded in DECISIONS.md.
 *
 * It needs the same retry as the transaction, and for the same reason: it writes
 * to the STATS item, the single most contended row in the table. Measured — with
 * no retry here, 33 of 200 updates failed with a 5xx under only five concurrent
 * requests, even though the transaction above was retrying correctly.
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


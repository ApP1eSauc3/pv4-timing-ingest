/**
 * The storage half of validation.
 *
 * The brief is specific that a corrupt payload must not vanish silently - we
 * should be able to tell it happened and get at the payload afterwards. So the
 * rejection record and the counter go into one transaction. Written separately
 * they could disagree, leaving either a stored payload nobody counted or a count
 * with no payload behind it, and at that point neither number means anything.
 *
 * Neither write carries a condition, so there is no accepted-versus-ignored
 * decision to make here. That is why this path stays simple while the valid one
 * in applyValid.ts does not.
 */

import { randomUUID } from 'node:crypto';
import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';

import { ddb, globalStatsShardKey, rejectionKey, TABLE_NAME } from './db';
import { withContentionRetry } from './retry';
import type { CheckName } from './types';

/**
 * DynamoDB caps an item at 400 KB, so this leaves room for everything else on
 * the record rather than filling it to the limit and then failing on metadata.
 */
const MAX_STORED_BODY_CHARS = 300 * 1024;

/** Corrupt payloads are evidence rather than records, and a week is plenty of
 *  time to go and look at one. */
const REJECTION_TTL_DAYS = 7;

export async function storeRejection(
  rawBody: string | undefined | null,
  failedChecks: CheckName[],
  requestId: string,
): Promise<void> {
  const receivedAt = new Date().toISOString();
  // An empty body and no body at all are both corrupt, but they are different
  // faults and the record ought to say which one turned up.
  const bodyMissing = rawBody == null;
  const body = rawBody ?? '';
  const truncated = body.length > MAX_STORED_BODY_CHARS;

  // Retried like every other write that touches a shared counter. Without it,
  // this path was the last thing still producing 5xx responses under load, since
  // every rejection in the pipeline increments the very same counter.
  await withContentionRetry(() =>
    ddb.send(
      new TransactWriteCommand({
        TransactItems: [
        {
          Put: {
            TableName: TABLE_NAME,
            Item: {
              // Time prefixed so these read back in arrival order, with a uuid
              // on the end so two arriving in the same millisecond cannot
              // overwrite one another.
              ...rejectionKey(`${receivedAt}#${randomUUID()}`),
              rawBody: truncated ? body.slice(0, MAX_STORED_BODY_CHARS) : body,
              truncated,
              bodyMissing,
              failedChecks,
              requestId,
              receivedAt,
              expiresAt: Math.floor(Date.now() / 1000) + REJECTION_TTL_DAYS * 24 * 60 * 60,
            },
          },
        },
        {
          Update: {
            TableName: TABLE_NAME,
            Key: globalStatsShardKey(),
            UpdateExpression: 'ADD updatesRejected :one',
            ExpressionAttributeValues: { ':one': 1 },
          },
        },
      ],
      }),
    ),
  );
}

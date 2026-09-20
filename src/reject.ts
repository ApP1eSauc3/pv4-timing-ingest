/**
 * Validation — processor rule 3, the storage half.
 *
 * A corrupt payload must not vanish silently: we should be able to tell that it
 * happened and get at the payload afterwards. So the rejection record and the
 * counter go in **one transaction**. Written separately they could disagree —
 * a stored payload with no count, or a count with no payload — and then neither
 * number can be trusted.
 *
 * There is no condition on either write, so this transaction has no
 * accepted-versus-ignored decision to make. That is why it is simple, and why
 * the valid path in `applyValid.ts` is not.
 */

import { randomUUID } from 'node:crypto';
import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';

import { ddb, globalStatsKey, rejectionKey, TABLE_NAME } from './db';
import type { CheckName } from './types';

/**
 * DynamoDB caps an item at 400 KB. Leave room for the other attributes rather
 * than storing right up to the limit and failing on the metadata.
 */
const MAX_STORED_BODY_CHARS = 300 * 1024;

/** Corrupt payloads are evidence, not records. Seven days is long enough to debug. */
const REJECTION_TTL_DAYS = 7;

export async function storeRejection(
  rawBody: string | undefined | null,
  failedChecks: CheckName[],
  requestId: string,
): Promise<void> {
  const receivedAt = new Date().toISOString();
  // An empty body and no body at all are both corrupt, but they are different
  // faults and the stored record should say which.
  const bodyMissing = rawBody == null;
  const body = rawBody ?? '';
  const truncated = body.length > MAX_STORED_BODY_CHARS;

  await ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: TABLE_NAME,
            Item: {
              // Time-prefixed so rejections read back in arrival order, with a
              // uuid suffix so two in the same millisecond cannot collide.
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
            Key: globalStatsKey(),
            UpdateExpression: 'ADD updatesRejected :one',
            ExpressionAttributeValues: { ':one': 1 },
          },
        },
      ],
    }),
  );
}

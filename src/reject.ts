/**
 * The storage half of validation.
 *
 * A corrupt payload must not vanish silently: we should be able to tell it
 * happened and get at the payload afterwards. So the rejection record and the
 * counter go in one transaction. Written separately they could disagree - a
 * stored payload nobody counted, or a count with no payload - and then neither
 * number can be trusted.
 *
 * Neither write carries a condition, so there is no accepted-versus-ignored
 * decision here. That is why this path is simple and applyValid.ts is not.
 */

import { randomUUID } from 'node:crypto';
import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';

import { ddb, globalStatsShardKey, rejectionKey, TABLE_NAME } from './db';
import { withContentionRetry } from './retry';
import type { CheckName } from './types';

/**
 * DynamoDB caps an item at 400 KB. This leaves room for the rest of the record
 * rather than filling to the limit and failing on the metadata.
 */
const MAX_STORED_BODY_CHARS = 300 * 1024;

/** Corrupt payloads are evidence, not records. A week is long enough to debug. */
const REJECTION_TTL_DAYS = 7;

export async function storeRejection(
  rawBody: string | undefined | null,
  failedChecks: CheckName[],
  requestId: string,
): Promise<void> {
  const receivedAt = new Date().toISOString();
  // An empty body and no body are both corrupt, but they are different faults
  // and the record should say which.
  const bodyMissing = rawBody == null;
  const body = rawBody ?? '';
  const truncated = body.length > MAX_STORED_BODY_CHARS;

  // Retried like every other write to a shared counter. Without it, this path
  // was the last source of 5xx under load: every rejection in the pipeline
  // increments the same counter.
  await withContentionRetry(() =>
    ddb.send(
      new TransactWriteCommand({
        TransactItems: [
        {
          Put: {
            TableName: TABLE_NAME,
            Item: {
              // Time-prefixed so these read back in arrival order, with a uuid
              // so two in the same millisecond cannot collide.
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

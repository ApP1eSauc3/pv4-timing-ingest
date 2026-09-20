/**
 * The DynamoDB client and every key this table uses.
 *
 * Keys live here and nowhere else. Written inline somewhere, the two copies
 * drift and the counters stop sharing a partition with the athletes, which is
 * the whole reason this layout works.
 *
 * Layout (one table, on-demand, TTL on `expiresAt`):
 *
 *   PK                  SK           Holds
 *   EVENT#<eventId>     BIB#<bib>    bib, lane, revision, status, timeMs, ...
 *   EVENT#<eventId>     STATS        updatesAccepted, updatesIgnored
 *   EVENTS              <eventId>    firstSeenAt
 *   GLOBAL              STATS        updatesRejected
 *   REJECTED            <id>         rawBody, failedChecks, requestId, expiresAt
 *
 * The counters share `EVENT#<eventId>` with every athlete on purpose: one Query
 * returns both, so `athletesTracked` is counted from the rows rather than stored
 * as a second source of truth that can drift.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

export const TABLE_NAME = process.env.TABLE_NAME ?? '';

export const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({
    // The SDK defaults to maxAttempts 3 and retries throttling itself. That
    // would sit underneath the retry policy in retry.ts, giving two layers with
    // two different backoffs and making the ~1.2 s worst case in that file
    // untrue. One attempt here means retry.ts is genuinely the only policy, and
    // its budget against the Lambda's 10 s timeout is the real one.
    //
    // The cost: a transient connection error is no longer retried by the SDK
    // and surfaces as a 5xx, which the feed re-sends. Contention and throttling
    // are both still retried, by us.
    maxAttempts: 1,
  }),
  {
    marshallOptions: {
      // recordedAt is optional and often absent. Without this the document
      // client throws on an undefined attribute instead of omitting it.
      removeUndefinedValues: true,
    },
  },
);

/** One athlete's current state within one event. */
export const resultKey = (eventId: string, bib: string) => ({
  PK: `EVENT#${eventId}`,
  SK: `BIB#${bib}`,
});

/**
 * Per-event counters, spread across a fixed number of rows.
 *
 * This was a single STATS item until load testing: every update for an event
 * increments the same row, so updates for different athletes collide on it.
 * Measured on the deployed stack, one row plus six retries still lost ~1% of
 * updates at five concurrent requests. The read adds the rows up, still in one
 * Query, since they share the partition.
 *
 * Twenty-five rather than ten, also from measurement. Ten left ~1 update in 200
 * failing, matching the arithmetic: five writers on ten rows collide about a
 * third of the time per attempt. Twenty-five rows and eight attempts clears it.
 */
export const STATS_SHARDS = 25;

/** Written to. Random rather than hashed on the bib: hashing pins each athlete
 *  to one row, so a burst for a single athlete would all land on it anyway. */
export const statsShardKey = (eventId: string, shard = Math.floor(Math.random() * STATS_SHARDS)) => ({
  PK: `EVENT#${eventId}`,
  SK: `STATS#${shard}`,
});

/** Read from: the partition every counter row and every athlete shares. */
export const statsKey = (eventId: string) => ({
  PK: `EVENT#${eventId}`,
  SK: 'STATS',
});

/** The registry of every event seen, so `events` needs no scan. */
export const eventRegistryKey = (eventId: string) => ({
  PK: 'EVENTS',
  SK: eventId,
});

/**
 * Pipeline-wide counters. `updatesRejected` is not per event because a corrupt
 * payload may not say which event it belonged to — or anything else.
 *
 * Spread for the same reason as the per-event counters, and busier: every
 * rejection in the pipeline increments it, whatever event it came from. On one
 * row with no retry it was the last remaining source of 5xx under load.
 */
export const globalStatsShardKey = (shard = Math.floor(Math.random() * STATS_SHARDS)) => ({
  PK: 'GLOBAL',
  SK: `STATS#${shard}`,
});

/** Read from: the partition holding every global counter shard. */
export const globalStatsKey = () => ({
  PK: 'GLOBAL',
  SK: 'STATS',
});

/** One stored corrupt payload. Time-ordered sort key, so these read back in
 *  arrival order. */
export const rejectionKey = (id: string) => ({
  PK: 'REJECTED',
  SK: id,
});

/**
 * The DynamoDB client, plus every key this table uses.
 *
 * Keys live here and nowhere else. The moment one gets written out inline
 * somewhere the two copies start to drift, and the counters stop sharing a
 * partition with the athletes - which is the entire reason this layout works.
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
 * The counters share `EVENT#<eventId>` with every athlete on purpose, so a
 * single Query brings back both at once and `athletesTracked` can be counted
 * from what comes back rather than stored as a second source of truth that would
 * eventually disagree with the first.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

export const TABLE_NAME = process.env.TABLE_NAME ?? '';

export const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: {
    // recordedAt is optional and frequently absent, and without this the
    // document client throws on an undefined attribute rather than leaving it
    // out - which would look like a bug in the transaction, not in the client.
    removeUndefinedValues: true,
  },
});

/** One athlete's current state inside one event. */
export const resultKey = (eventId: string, bib: string) => ({
  PK: `EVENT#${eventId}`,
  SK: `BIB#${bib}`,
});

/**
 * Per-event counters, spread across a fixed number of rows.
 *
 * These were a single STATS item until load testing showed me why that does not
 * hold up: every update for an event increments the same row, so updates for
 * completely different athletes still end up colliding on it. Measured against
 * the deployed stack, one row plus six retries still lost about 1% of updates at
 * only five concurrent requests. Spreading the writes fixes that, and the read
 * simply adds them up - still one Query, since they all share the partition.
 *
 * Twenty-five rather than ten, and that came from measurement too. Ten left
 * roughly one update in two hundred failing, which matches the arithmetic: with
 * five writers in flight, each attempt on ten rows collides about a third of the
 * time. Twenty-five rows and eight attempts puts it comfortably out of reach.
 */
export const STATS_SHARDS = 25;

/** Written to. Random rather than hashed on the bib, because hashing would pin
 *  each athlete to one row and a burst for a single athlete - exactly the case
 *  that causes collisions - would all land on it anyway. */
export const statsShardKey = (eventId: string, shard = Math.floor(Math.random() * STATS_SHARDS)) => ({
  PK: `EVENT#${eventId}`,
  SK: `STATS#${shard}`,
});

/** Read from: the partition that every counter row and every athlete shares. */
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
 * Spread for the same reason as the per-event counters, and this one is the
 * busier of the two: every rejection anywhere in the pipeline increments it,
 * whatever event it came from. On one row and with no retry it was the last
 * remaining source of 5xx responses under load, which took me three rounds of
 * looking in the wrong place to find.
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

/** One stored corrupt payload. The sort key is time ordered, so these read back
 *  in the order they arrived. */
export const rejectionKey = (id: string) => ({
  PK: 'REJECTED',
  SK: id,
});

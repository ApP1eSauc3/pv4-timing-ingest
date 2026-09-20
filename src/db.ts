/**
 * The DynamoDB client and every key this table uses.
 *
 * Keys live here and nowhere else. If a key string is written out inline
 * somewhere, the two copies drift and the stats item stops sharing a partition
 * with the athletes, which is the whole reason the layout works.
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
 * The stats item shares `EVENT#<eventId>` with every athlete on purpose: one
 * Query returns the counters and the athletes together, so `athletesTracked` is
 * counted from the result rather than stored as a second source of truth.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

export const TABLE_NAME = process.env.TABLE_NAME ?? '';

export const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: {
    // `recordedAt` is optional and often absent. Without this the document
    // client throws on an undefined attribute instead of omitting it.
    removeUndefinedValues: true,
  },
});

/** One athlete's current state within one event. */
export const resultKey = (eventId: string, bib: string) => ({
  PK: `EVENT#${eventId}`,
  SK: `BIB#${bib}`,
});

/**
 * Per-event counters, spread across a fixed number of shards.
 *
 * They were a single `STATS` item until load testing showed why that does not
 * work: every update for an event increments the same row, so updates for
 * *different athletes* still collide on it. Measured on the deployed stack, one
 * item plus six retries still failed ~1% of updates at only five concurrent
 * requests. Sharding spreads those writes; the read sums them, which is still
 * one Query because they share the partition.
 *
 * Twenty-five rather than ten, from measurement: ten left roughly one update in
 * two hundred still failing, which matches the collision arithmetic — with five
 * writers in flight, each attempt on ten shards collides about a third of the
 * time. Twenty-five shards and eight attempts puts it out of reach.
 */
export const STATS_SHARDS = 25;

/** Written to. Random rather than hashed on bib: a burst for one athlete would
 *  otherwise still land on one shard, which is exactly the conflict case. */
export const statsShardKey = (eventId: string, shard = Math.floor(Math.random() * STATS_SHARDS)) => ({
  PK: `EVENT#${eventId}`,
  SK: `STATS#${shard}`,
});

/** Read from: the partition every counter shard and every athlete shares. */
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
 */
export const globalStatsKey = () => ({
  PK: 'GLOBAL',
  SK: 'STATS',
});

/** One stored corrupt payload. Sort key is time-ordered so these read newest-last. */
export const rejectionKey = (id: string) => ({
  PK: 'REJECTED',
  SK: id,
});

/**
 * Turning one DynamoDB Query into an EventStats.
 *
 * The stats item and every athlete share the partition key `EVENT#<eventId>`,
 * so a single Query returns both. That is the whole reason for the layout:
 *
 *   athletesTracked is COUNTED from the BIB# items, never stored as a counter.
 *
 * A counter would be a second source of truth that can drift out of step with
 * the athletes it claims to count. A count cannot — it is derived from the rows
 * themselves every time it is asked for.
 *
 * Absence is a value, not an error. An event nobody has posted to returns zeros,
 * because the schema says `EventStats!` and a null would break the contract.
 */

import type { EventStatsShape } from './types';

type Item = Record<string, unknown>;

export function shapeEventStats(eventId: string, items: Item[]): EventStatsShape {
  const sk = (item: Item) => (typeof item.SK === 'string' ? item.SK : '');

  // Counters live in shards (`STATS#0`..`STATS#9`) so concurrent updates do not
  // all collide on one row. `STATS` without a suffix is also matched: events
  // written before sharding still read correctly.
  const counters = items.filter((item) => sk(item).startsWith('STATS'));
  const athletes = items.filter((item) => sk(item).startsWith('BIB#'));

  const sum = (field: string) =>
    counters.reduce((total, item) => total + Number(item[field] ?? 0), 0);

  return {
    eventId,
    athletesTracked: athletes.length,
    updatesAccepted: sum('updatesAccepted'),
    updatesIgnored: sum('updatesIgnored'),
  };
}

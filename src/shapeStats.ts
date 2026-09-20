/**
 * Turning one DynamoDB Query into an EventStats.
 *
 * The counters and every athlete share the partition key `EVENT#<eventId>`, so
 * one Query returns both. That is the point of the layout:
 *
 *   athletesTracked is COUNTED from the athlete rows, never stored as a number.
 *
 * A stored counter is a second source of truth and can drift from the athletes
 * it claims to count. A count cannot - it is derived from the rows every time.
 *
 * Absence is a value, not an error. An event nobody has posted to returns zeros,
 * because the schema promises EventStats! and a null would break the contract.
 */

import type { EventStatsShape } from './types';

type Item = Record<string, unknown>;

export function shapeEventStats(eventId: string, items: Item[]): EventStatsShape {
  const sk = (item: Item) => (typeof item.SK === 'string' ? item.SK : '');

  // Counters live across several rows so concurrent updates do not all collide
  // on one. A plain `STATS` with no suffix is matched too, so events written
  // before sharding still read correctly rather than reporting zeros.
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

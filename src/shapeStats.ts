/**
 * Turning a single DynamoDB Query into an EventStats.
 *
 * The counters and every athlete share the partition key `EVENT#<eventId>`, so
 * one Query brings back both together. That is the whole point of the layout,
 * and it leads to the decision I like most in this project:
 *
 *   athletesTracked is COUNTED from the athlete rows, never stored as a number.
 *
 * A stored counter is a second source of truth, and given enough concurrency it
 * will eventually disagree with the athletes it claims to be counting. A count
 * cannot, since it is worked out from the rows themselves every time somebody
 * asks for it.
 *
 * Absence is treated as a value rather than an error. An event nobody has posted
 * to comes back as zeros, because the schema promises EventStats! and a null
 * there would break the contract their harness runs against.
 */

import type { EventStatsShape } from './types';

type Item = Record<string, unknown>;

export function shapeEventStats(eventId: string, items: Item[]): EventStatsShape {
  const sk = (item: Item) => (typeof item.SK === 'string' ? item.SK : '');

  // Counters live across several rows so concurrent updates are not all fighting
  // over one of them. A plain `STATS` with no suffix is matched too, so events
  // written before that change still read back correctly instead of silently
  // reporting zeros.
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

/**
 * The read API: one Lambda behind all four AppSync queries.
 *
 * Chosen over AppSync's JavaScript resolvers deliberately, not as a fallback.
 * Everything else here is TypeScript with tests that run locally in about a
 * second; APPSYNC_JS resolvers would be untyped JavaScript testable only by
 * calling AWS. The shaping this needs - splitting one Query into counters and
 * athletes - is four lines here and an awkward template there.
 *
 * This function only reads, and is granted read-only access to the table, so a
 * bug in it cannot change a result.
 */

import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { AppSyncResolverEvent } from 'aws-lambda';

import { ddb, globalStatsKey, statsKey, TABLE_NAME } from './db';
import { shapeEventStats } from './shapeStats';
import type { EventStatsShape, ResultStatus } from './types';

type Args = { eventId?: string };

type ResultShape = {
  bib: string;
  lane: number;
  revision: number;
  status: ResultStatus;
  timeMs: number;
};

/** Every page of a partition. `events` grows with the number of events ever
 *  seen, so it is the one query that needs paging. */
async function queryAll(
  keyConditionExpression: string,
  values: Record<string, unknown>,
): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  let startKey: Record<string, unknown> | undefined;

  do {
    const page = await ddb.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: keyConditionExpression,
        ExpressionAttributeValues: values,
        ExclusiveStartKey: startKey,
      }),
    );
    items.push(...(page.Items ?? []));
    startKey = page.LastEvaluatedKey;
  } while (startKey);

  return items;
}

export async function handler(
  event: AppSyncResolverEvent<Args>,
): Promise<string[] | ResultShape[] | EventStatsShape | number> {
  const field = event.info.fieldName;
  const eventId = event.arguments?.eventId ?? '';

  switch (field) {
    // Every event ever posted to. Empty list when there are none, never null.
    case 'events': {
      const items = await queryAll('PK = :pk', { ':pk': 'EVENTS' });
      return items.map((item) => String(item.SK));
    }

    // One event's athletes. begins_with keeps the counter rows out.
    case 'results': {
      const items = await queryAll('PK = :pk AND begins_with(SK, :bib)', {
        ':pk': `EVENT#${eventId}`,
        ':bib': 'BIB#',
      });

      // Only the five fields the contract declares. recordedAt and updatedAt
      // are stored but never exposed - recordedAt comes from a clock we do not
      // trust, and putting it on the wire invites someone to sort by it.
      return items.map((item) => ({
        bib: String(item.bib),
        lane: Number(item.lane),
        revision: Number(item.revision),
        status: item.status as ResultStatus,
        timeMs: Number(item.timeMs),
      }));
    }

    // One Query covers the counters and the athlete count - same partition.
    case 'eventStats': {
      const items = await queryAll('PK = :pk', { ':pk': statsKey(eventId).PK });
      return shapeEventStats(eventId, items);
    }

    // Pipeline-wide: a corrupt payload may not say which event it came from.
    case 'updatesRejected': {
      // Summed across the counter rows, like the per-event ones. Older
      // single-row items are included, so nothing stops being counted.
      const items = await queryAll('PK = :pk', { ':pk': globalStatsKey().PK });
      return items.reduce((total, item) => total + Number(item.updatesRejected ?? 0), 0);
    }

    // An unknown field means the schema and the resolvers have drifted. A zero
    // would hide that, and their harness runs against this contract, so fail.
    default:
      throw new Error(`unknown field: ${field}`);
  }
}

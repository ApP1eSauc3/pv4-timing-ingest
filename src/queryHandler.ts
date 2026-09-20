/**
 * The read API: one Lambda sitting behind all four AppSync queries.
 *
 * I chose this over AppSync's JavaScript resolvers deliberately rather than as a
 * fallback. Everything else here is TypeScript with tests that run locally in
 * about a second, whereas APPSYNC_JS resolvers would have been untyped
 * JavaScript that can only really be tested by calling AWS - the one untested
 * corner of the project. The shaping this API needs, splitting one Query into
 * counters and athletes, is also four lines of ordinary code here and an awkward
 * template there.
 *
 * This function only ever reads, and it is granted read-only access to the
 * table, so even a bug in it cannot change a result.
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
 *  seen, so it is the one query here that needs paging at all. */
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
    // Every event ever posted to, and an empty list when there are none rather
    // than a null, since the schema promises a list either way.
    case 'events': {
      const items = await queryAll('PK = :pk', { ':pk': 'EVENTS' });
      return items.map((item) => String(item.SK));
    }

    // One event's athletes, with begins_with keeping the counter rows out of it.
    case 'results': {
      const items = await queryAll('PK = :pk AND begins_with(SK, :bib)', {
        ':pk': `EVENT#${eventId}`,
        ':bib': 'BIB#',
      });

      // Only the five fields the contract declares. recordedAt and updatedAt are
      // stored but deliberately never exposed - recordedAt especially, since it
      // comes from a clock nobody trusts and putting it on the wire invites
      // somebody downstream to sort by it.
      return items.map((item) => ({
        bib: String(item.bib),
        lane: Number(item.lane),
        revision: Number(item.revision),
        status: item.status as ResultStatus,
        timeMs: Number(item.timeMs),
      }));
    }

    // A single Query covers both the counters and the athlete count, since they
    // all live in the same partition.
    case 'eventStats': {
      const items = await queryAll('PK = :pk', { ':pk': statsKey(eventId).PK });
      return shapeEventStats(eventId, items);
    }

    // Counted across the whole pipeline, because a corrupt payload may well not
    // say which event it came from.
    case 'updatesRejected': {
      // Added up across the counter rows, exactly like the per-event ones. The
      // older single-row items are included as well, so nothing that was already
      // counted ever quietly stops being counted.
      const items = await queryAll('PK = :pk', { ':pk': globalStatsKey().PK });
      return items.reduce((total, item) => total + Number(item.updatesRejected ?? 0), 0);
    }

    // An unknown field means the schema and the resolvers have drifted apart.
    // Returning a zero would hide that, and since their harness runs against
    // this contract, I would much rather it failed loudly here.
    default:
      throw new Error(`unknown field: ${field}`);
  }
}

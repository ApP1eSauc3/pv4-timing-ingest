/**
 * The read API: one Lambda behind all four AppSync queries.
 *
 * Chosen over AppSync's JavaScript resolvers deliberately. The rest of this
 * project is TypeScript with tests that run locally; APPSYNC_JS resolvers would
 * have been untyped JavaScript that can only be tested by calling AWS. The
 * shaping this API needs — splitting one Query's results into counters and
 * athletes — is also plain code here and awkward in a resolver template.
 *
 * This function only ever reads. It is granted read-only access to the table,
 * so even a bug cannot change a result.
 */

import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
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

/** Every page of a partition. `events` grows with the number of events ever seen. */
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
    // Every event ever posted to. Returns [] when there are none — never null.
    case 'events': {
      const items = await queryAll('PK = :pk', { ':pk': 'EVENTS' });
      return items.map((item) => String(item.SK));
    }

    // One event's athletes. `begins_with` keeps the STATS item out of the list.
    case 'results': {
      const items = await queryAll('PK = :pk AND begins_with(SK, :bib)', {
        ':pk': `EVENT#${eventId}`,
        ':bib': 'BIB#',
      });

      // Only the five fields the contract declares. recordedAt and updatedAt are
      // stored but deliberately not exposed — recordedAt in particular comes
      // from a clock we do not trust and must not be used for anything.
      return items.map((item) => ({
        bib: String(item.bib),
        lane: Number(item.lane),
        revision: Number(item.revision),
        status: item.status as ResultStatus,
        timeMs: Number(item.timeMs),
      }));
    }

    // One Query for both counters and the athlete count — they share a partition.
    case 'eventStats': {
      const items = await queryAll('PK = :pk', { ':pk': statsKey(eventId).PK });
      return shapeEventStats(eventId, items);
    }

    // Pipeline-wide, because a corrupt payload may not say which event it was.
    case 'updatesRejected': {
      const got = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: globalStatsKey() }));
      return Number(got.Item?.updatesRejected ?? 0);
    }

    // An unknown field means the schema and the resolvers disagree. Returning a
    // zero would hide that; the contract is automated against, so it should fail.
    default:
      throw new Error(`unknown field: ${field}`);
  }
}

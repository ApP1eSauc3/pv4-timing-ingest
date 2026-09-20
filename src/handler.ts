/**
 * The ingest Lambda: POST /timing.
 *
 * Order is deliberate and never changes:
 *
 *   decode -> size check -> parse -> validate -> write
 *
 * Nothing touches DynamoDB until validation has passed, so a corrupt payload
 * cannot create a phantom athlete who was never in the race.
 *
 * Every update that reaches this function lands in exactly one of three
 * buckets: accepted, ignored or rejected. A 5xx is not a fourth bucket — it
 * means we do not know what happened, nothing was counted, and the feed should
 * re-send. That is why an infrastructure failure must throw rather than be
 * quietly recorded as "ignored".
 */

import { Logger } from '@aws-lambda-powertools/logger';
import { MetricUnit, Metrics } from '@aws-lambda-powertools/metrics';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';

import { applyValid } from './applyValid';
import { storeRejection } from './reject';
import { validateBody } from './validate';

const logger = new Logger({ serviceName: 'pv4-ingest' });

/**
 * Metrics are emitted as EMF in the logs, so they cost nothing extra to publish.
 *
 * Deliberately NO per-event or per-bib dimensions. Metric cost is per unique
 * combination of metric and dimension values, so a dimension that grows with the
 * data — a bib, an event id — turns a free metric into an unbounded bill. Those
 * belong in the log fields, where they already are, and where they can be
 * queried without being charged per distinct value.
 */
const metrics = new Metrics({ namespace: 'PV4/Timing', serviceName: 'pv4-ingest' });

const json = (statusCode: number, body: unknown): APIGatewayProxyResultV2 => ({
  statusCode,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  // Per invocation, so a warm container cannot carry the previous request's
  // numbers into this one.
  metrics.clearMetrics();

  // HTTP API always populates this. The fallback is only for a hand-crafted
  // test invocation that has no requestContext.
  const requestId = event.requestContext?.requestId ?? 'unknown';

  // API Gateway base64-encodes some bodies (content types it treats as binary).
  // Validating the encoded string would reject every one of them as corrupt.
  const rawBody =
    event.isBase64Encoded && event.body
      ? Buffer.from(event.body, 'base64').toString('utf8')
      : event.body;

  const validation = validateBody(rawBody);

  if (!validation.valid) {
    // Rejections are counted pipeline-wide, not per event: a corrupt payload
    // may not say which event it belonged to.
    await storeRejection(rawBody, validation.failedChecks, requestId);

    logger.warn('update rejected', {
      requestId,
      outcome: 'REJECTED',
      failedChecks: validation.failedChecks,
    });

    metrics.addMetric('UpdatesRejected', MetricUnit.Count, 1);
    metrics.publishStoredMetrics();

    return json(400, { outcome: 'REJECTED', failedChecks: validation.failedChecks });
  }

  const { eventId, bib, revision, status } = validation.update;

  // Logged per call rather than with appendKeys: persistent keys survive a warm
  // invocation, so a later request for a different bib would carry this one's
  // bib and the trace would be a lie.
  const context = { requestId, eventId, bib, revision, status };

  const outcome = await applyValid(validation.update, requestId);

  logger.info(`update ${outcome.toLowerCase()}`, { ...context, outcome });

  metrics.addMetric(outcome === 'ACCEPTED' ? 'UpdatesAccepted' : 'UpdatesIgnored', MetricUnit.Count, 1);
  metrics.publishStoredMetrics();

  return json(200, { outcome });
}

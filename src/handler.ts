/**
 * The ingest Lambda, behind POST /timing.
 *
 * The order is deliberate and never changes:
 *
 *   decode -> size check -> parse -> validate -> write
 *
 * Nothing reaches DynamoDB until validation passes, so a corrupt payload cannot
 * create a phantom athlete who was never in the race.
 *
 * Every update that gets this far lands in exactly one of accepted, ignored or
 * rejected. A 5xx is not a fourth bucket - it means we do not know what
 * happened, nothing is counted, and the feed re-sends. So an infrastructure
 * failure throws rather than being filed as "ignored".
 */

import { Logger } from '@aws-lambda-powertools/logger';
import { MetricUnit, Metrics } from '@aws-lambda-powertools/metrics';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';

import { applyValid } from './applyValid';
import { storeRejection } from './reject';
import { validateBody } from './validate';

const logger = new Logger({ serviceName: 'pv4-ingest' });

/**
 * Metrics go out as EMF in the logs, so they cost nothing extra to publish.
 *
 * No per-event or per-athlete dimensions. CloudWatch charges per unique
 * combination of metric and dimension values, so an unbounded dimension like a
 * bib turns a free metric into a growing bill. Those stay in the log fields,
 * where they can be searched without being charged per distinct value.
 */
const metrics = new Metrics({ namespace: 'PV4/Timing', serviceName: 'pv4-ingest' });

const json = (statusCode: number, body: unknown): APIGatewayProxyResultV2 => ({
  statusCode,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  // Cleared per invocation: a warm container would otherwise carry the previous
  // request's numbers into this one.
  metrics.clearMetrics();

  // The HTTP API always sets this. The fallback is for a hand-made test
  // invocation with no request context.
  const requestId = event.requestContext?.requestId ?? 'unknown';

  // API Gateway base64-encodes anything it treats as binary. Validating the
  // encoded string would reject those as corrupt.
  const rawBody =
    event.isBase64Encoded && event.body
      ? Buffer.from(event.body, 'base64').toString('utf8')
      : event.body;

  const validation = validateBody(rawBody);

  if (!validation.valid) {
    // Counted pipeline-wide, not per event: a corrupt payload may not say which
    // event it belonged to.
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

  // Logged per call rather than with appendKeys. Persistent keys survive a warm
  // invocation, so a later request for a different athlete would carry this
  // one's bib - a trace pointing at the wrong athlete is worse than none.
  const context = { requestId, eventId, bib, revision, status };

  const outcome = await applyValid(validation.update, requestId);

  logger.info(`update ${outcome.toLowerCase()}`, { ...context, outcome });

  metrics.addMetric(outcome === 'ACCEPTED' ? 'UpdatesAccepted' : 'UpdatesIgnored', MetricUnit.Count, 1);
  metrics.publishStoredMetrics();

  return json(200, { outcome });
}

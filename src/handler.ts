/**
 * The ingest Lambda, sitting behind POST /timing.
 *
 * The order here is deliberate and never changes:
 *
 *   decode -> size check -> parse -> validate -> write
 *
 * Nothing reaches DynamoDB until validation has passed, which is what stops a
 * corrupt payload from creating a phantom athlete who was never in the race.
 *
 * Every update that gets this far lands in exactly one of three buckets:
 * accepted, ignored or rejected. A 5xx is not a fourth bucket. It means we
 * genuinely do not know what happened, so nothing is counted and the feed
 * re-sends. Consequently an infrastructure failure has to throw rather than be
 * quietly filed as "ignored", which would balance the books with a wrong number.
 */

import { Logger } from '@aws-lambda-powertools/logger';
import { MetricUnit, Metrics } from '@aws-lambda-powertools/metrics';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';

import { applyValid } from './applyValid';
import { storeRejection } from './reject';
import { validateBody } from './validate';

const logger = new Logger({ serviceName: 'pv4-ingest' });

/**
 * Metrics go out as EMF inside the logs, so publishing them costs nothing extra.
 *
 * Deliberately with no per-event or per-athlete dimensions. CloudWatch charges
 * per unique combination of metric and dimension values, so breaking these down
 * by something unbounded like a bib turns a free metric into a bill that grows
 * with the meet. Those details are already in the log fields below, where they
 * can be searched without being charged for per distinct value.
 */
const metrics = new Metrics({ namespace: 'PV4/Timing', serviceName: 'pv4-ingest' });

const json = (statusCode: number, body: unknown): APIGatewayProxyResultV2 => ({
  statusCode,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  // Cleared per invocation, otherwise a warm container carries the previous
  // request's numbers into this one and the metric quietly double counts.
  metrics.clearMetrics();

  // The HTTP API always sets this. The fallback only exists for a hand-made test
  // invocation that arrives with no request context attached.
  const requestId = event.requestContext?.requestId ?? 'unknown';

  // API Gateway base64 encodes anything it treats as binary, and validating the
  // encoded string would reject every one of those as corrupt when they are
  // perfectly good updates.
  const rawBody =
    event.isBase64Encoded && event.body
      ? Buffer.from(event.body, 'base64').toString('utf8')
      : event.body;

  const validation = validateBody(rawBody);

  if (!validation.valid) {
    // Rejections are counted across the whole pipeline rather than per event,
    // since a corrupt payload may not tell us which event it belonged to - or
    // anything else about itself.
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
  // invocation, so a later request for a different athlete would arrive carrying
  // this one's bib, and a trace that confidently points at the wrong athlete is
  // worse than no trace at all.
  const context = { requestId, eventId, bib, revision, status };

  const outcome = await applyValid(validation.update, requestId);

  logger.info(`update ${outcome.toLowerCase()}`, { ...context, outcome });

  metrics.addMetric(outcome === 'ACCEPTED' ? 'UpdatesAccepted' : 'UpdatesIgnored', MetricUnit.Count, 1);
  metrics.publishStoredMetrics();

  return json(200, { outcome });
}

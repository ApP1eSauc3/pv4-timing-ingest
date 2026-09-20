/**
 * The deployed-stack harness.
 *
 * Not a unit test and deliberately not named `*.test.ts`, so `npm test` never
 * fires live traffic at AWS. Run it explicitly:
 *
 *   npm run harness
 *
 * It exists because everything that actually went wrong in this project went
 * wrong at the boundary between correct-looking code and what DynamoDB accepts.
 * Unit tests and static checks both passed against a transaction that failed
 * every single call. Only the deployed stack caught it.
 *
 * Two scenarios:
 *
 *   1. Volume  — 200 updates across 8 bibs, shuffled, ~20% duplicates,
 *                ~10% corrupt. Asserts the counters balance AND that the final
 *                state of every bib is its highest valid revision.
 *   2. Conflict — revisions 1-6 for ONE bib fired simultaneously, repeated.
 *                Asserts the final revision is always 6. This is the case that
 *                distinguishes a real implementation from one that miscounts a
 *                write collision as a stale revision.
 */

import assert from 'node:assert/strict';

const INGEST_URL = process.env.INGEST_URL ?? '';
const GQL_URL = process.env.GQL_URL ?? '';
const GQL_KEY = process.env.GQL_KEY ?? '';

for (const [name, value] of Object.entries({ INGEST_URL, GQL_URL, GQL_KEY })) {
  if (!value) throw new Error(`${name} is not set — export it from the stack outputs first`);
}

const STATUSES = ['PROVISIONAL', 'CONFIRMED', 'OFFICIAL'] as const;

/** A fresh event per run, so a re-run never reads another run's counters. */
const eventId = `HARNESS-${new Date().toISOString().replace(/[:.]/g, '-')}`;

type Posted = { revision: number; valid: boolean };

const post = (body: unknown) =>
  fetch(INGEST_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

async function graphql(query: string): Promise<Record<string, unknown>> {
  const response = await fetch(GQL_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': GQL_KEY },
    body: JSON.stringify({ query }),
  });
  const json = (await response.json()) as { data?: Record<string, unknown>; errors?: unknown };
  if (json.errors) throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
  return json.data ?? {};
}

const readRejected = async () =>
  Number((await graphql('{ updatesRejected }')).updatesRejected);

/**
 * Account Lambda concurrency here is 10, shared with other workloads. Posting
 * 200 requests at once would throttle them, and a throttled request never
 * reaches the processor, so it could not be counted — that would look like a
 * counting bug when it is a quota limit. Five in flight keeps well clear.
 */
async function postAll(bodies: unknown[], parallel = 5): Promise<string[]> {
  const outcomes: string[] = [];
  for (let i = 0; i < bodies.length; i += parallel) {
    const batch = bodies.slice(i, i + parallel);
    const responses = await Promise.all(batch.map(post));
    for (const response of responses) {
      const text = await response.text();
      // A rejection is a 400 carrying {"outcome":"REJECTED"} — an expected
      // outcome, not a failure. Only a 5xx means the processor could not say
      // what happened, and those are the ones that must never occur.
      if (response.status === 200 || response.status === 400) {
        outcomes.push(JSON.parse(text).outcome);
      } else {
        outcomes.push(`HTTP_${response.status}`);
      }
    }
  }
  return outcomes;
}

function buildVolumeScenario() {
  const bibs = Array.from({ length: 8 }, (_, i) => `AUS-${1100 + i}`);
  const bodies: unknown[] = [];
  const expected = new Map<string, Posted[]>(bibs.map((b) => [b, []]));

  for (let i = 0; i < 200; i += 1) {
    const bib = bibs[i % bibs.length];
    const history = expected.get(bib)!;

    // ~10% corrupt. Each one breaks exactly one rule from the brief's table.
    if (i % 10 === 7) {
      const corrupt = [
        { eventId, bib, lane: 3, revision: 0, status: 'CONFIRMED', timeMs: 10105 },
        { eventId, bib, lane: 3, revision: 2, status: 'official', timeMs: 10105 },
        { eventId, bib, lane: 3, revision: 2, status: 'CONFIRMED', timeMs: -1 },
        { eventId, bib: '', lane: 3, revision: 2, status: 'CONFIRMED', timeMs: 10105 },
        'not json at all',
      ][i % 5];
      bodies.push(corrupt);
      history.push({ revision: NaN, valid: false });
      continue;
    }

    // ~20% duplicates: re-send the previous revision for this bib.
    const previous = history.filter((h) => h.valid).at(-1)?.revision;
    const revision = i % 5 === 3 && previous ? previous : 1 + Math.floor(Math.random() * 12);

    bodies.push({
      eventId,
      bib,
      lane: 3,
      revision,
      status: STATUSES[i % STATUSES.length],
      timeMs: 9000 + i,
      recordedAt: '2026-08-25T19:42:07.000Z',
    });
    history.push({ revision, valid: true });
  }

  // Shuffle: a later revision may now arrive before an earlier one.
  for (let i = bodies.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [bodies[i], bodies[j]] = [bodies[j], bodies[i]];
  }

  return { bodies, expected };
}

async function volumeScenario(): Promise<void> {
  console.log(`\n── Scenario 1: volume ────────────────────────────────`);
  console.log(`event ${eventId}`);

  const { bodies, expected } = buildVolumeScenario();
  const rejectedBefore = await readRejected();

  const outcomes = await postAll(bodies);
  const counted = {
    accepted: outcomes.filter((o) => o === 'ACCEPTED').length,
    ignored: outcomes.filter((o) => o === 'IGNORED').length,
    rejected: outcomes.filter((o) => o === 'REJECTED').length,
    failed: outcomes.filter((o) => o.startsWith('HTTP_')).length,
  };

  const data = (await graphql(`{
    results(eventId:"${eventId}") { bib revision }
    eventStats(eventId:"${eventId}") { athletesTracked updatesAccepted updatesIgnored }
  }`)) as {
    results: { bib: string; revision: number }[];
    eventStats: { athletesTracked: number; updatesAccepted: number; updatesIgnored: number };
  };

  const rejectedDelta = (await readRejected()) - rejectedBefore;
  const stats = data.eventStats;

  console.log(`sent      ${bodies.length}`);
  console.log(`accepted  ${stats.updatesAccepted}   (responses said ${counted.accepted})`);
  console.log(`ignored   ${stats.updatesIgnored}   (responses said ${counted.ignored})`);
  console.log(`rejected  ${rejectedDelta}   (responses said ${counted.rejected})`);
  console.log(`5xx       ${counted.failed}`);
  console.log(`athletes  ${stats.athletesTracked}`);

  assert.equal(counted.failed, 0, 'no update should have failed outright');

  // The invariant: every update lands in exactly one bucket.
  assert.equal(
    stats.updatesAccepted + stats.updatesIgnored + rejectedDelta,
    bodies.length,
    'accepted + ignored + rejected must equal sent',
  );

  // The stored counters must agree with what the processor told each caller.
  assert.equal(stats.updatesAccepted, counted.accepted, 'accepted counter disagrees with responses');
  assert.equal(stats.updatesIgnored, counted.ignored, 'ignored counter disagrees with responses');
  assert.equal(rejectedDelta, counted.rejected, 'rejected counter disagrees with responses');

  // Balanced is not the same as correct: check the state, per bib.
  for (const [bib, history] of expected) {
    const highest = Math.max(...history.filter((h) => h.valid).map((h) => h.revision));
    const stored = data.results.find((r) => r.bib === bib);
    assert.ok(stored, `${bib} missing from results`);
    assert.equal(stored.revision, highest, `${bib} should be at its highest revision`);
  }

  assert.equal(stats.athletesTracked, expected.size, 'every bib should be tracked exactly once');
  console.log('✓ counters balance, and every bib is at its highest revision');
}

async function conflictScenario(rounds = 20): Promise<void> {
  console.log(`\n── Scenario 2: concurrent writes to one bib ──────────`);

  const before = (await graphql(`{ eventStats(eventId:"${eventId}"){ updatesAccepted updatesIgnored } }`)) as {
    eventStats: { updatesAccepted: number; updatesIgnored: number };
  };
  let accepted = 0;

  for (let round = 1; round <= rounds; round += 1) {
    const bib = `CONFLICT-${round}`;

    // All six at once. They race on the same result item AND on the shared
    // stats item, which is where TransactionConflict actually comes from.
    await Promise.all(
      [1, 2, 3, 4, 5, 6].map((revision) =>
        post({ eventId, bib, lane: 4, revision, status: 'CONFIRMED', timeMs: 10000 + revision }),
      ),
    );

    const data = (await graphql(`{ results(eventId:"${eventId}") { bib revision } }`)) as {
      results: { bib: string; revision: number }[];
    };
    const stored = data.results.find((r) => r.bib === bib);

    // The assertion that matters. Counters can balance while a result is stuck
    // at an old revision — that is the failure this whole design exists to
    // prevent, and only the state shows it.
    assert.ok(stored, `${bib} missing after concurrent writes`);
    assert.equal(stored.revision, 6, `round ${round}: stuck at revision ${stored.revision}, expected 6`);

    accepted += 6;
    process.stdout.write(`r${round}:${stored.revision} `);
  }

  const after = (await graphql(`{ eventStats(eventId:"${eventId}"){ updatesAccepted updatesIgnored } }`)) as {
    eventStats: { updatesAccepted: number; updatesIgnored: number };
  };

  // Six distinct revisions fired at once must produce exactly six accepts and
  // no ignores per round. If a retry ever re-applied a write whose response was
  // lost, the accepted count would exceed this — the one check that would catch
  // a duplicate accept under retry.
  assert.equal(
    after.eventStats.updatesAccepted - before.eventStats.updatesAccepted,
    accepted,
    'accepted count must be exactly 6 per round — no double counting under retry',
  );
  assert.equal(
    after.eventStats.updatesIgnored - before.eventStats.updatesIgnored,
    0,
    'six distinct revisions should produce no ignores',
  );

  console.log(`\n✓ ${rounds} rounds, final revision 6 every time, ${accepted} accepted, 0 ignored`);
}

async function main(): Promise<void> {
  await volumeScenario();
  await conflictScenario();
  console.log('\nAll harness assertions passed.\n');
}

main().catch((error) => {
  console.error('\nHARNESS FAILED:', error.message);
  process.exit(1);
});

# lib/ — CDK infrastructure

Last updated: 2026-09-20

Everything AWS: the table, the ingest Lambda and HTTP route, AppSync, the
CloudFront/S3 page, and observability. One stack, `Pv4TimingStack`.

## Inputs

| Read | For |
|---|---|
| `../CLAUDE.md` | Naming, teardown rule, the counting invariant |
| `../src/CONTEXT.md` | Table layout — it is defined there, built here |
| `../DECISIONS.md` | Decisions already settled |

## Process

**First task in this directory:** `cdk init` named the stack
`CandidateBriefTestStack` after the folder. Rename it to `Pv4TimingStack` —
`bin/candidate_brief_test.ts`, `lib/candidate_brief_test-stack.ts`, the class, and
`test/candidate_brief_test.test.ts`. Do it before anything is deployed; renaming a
deployed stack destroys and recreates it.

**The read contract is fixed and automated against.** This schema must appear
exactly as written — additions alongside it are fine, changes are not:

```graphql
enum ResultStatus { PROVISIONAL CONFIRMED OFFICIAL }

type Result      { bib: ID!  lane: Int!  revision: Int!  status: ResultStatus!  timeMs: Int! }
type EventStats  { eventId: ID!  athletesTracked: Int!  updatesAccepted: Int!  updatesIgnored: Int! }

type Query {
  events:                   [ID!]!
  results(eventId: ID!):    [Result!]!
  eventStats(eventId: ID!): EventStats!
  updatesRejected:          Int!
}
```

Resolvers: `events` = Query PK `EVENTS` · `results` = Query PK `EVENT#<id>` +
`begins_with(SK, 'BIB#')` · `eventStats` = **one** Query on PK `EVENT#<id>`,
splitting the `STATS` item from the `BIB#` items in the response · `updatesRejected`
= GetItem on `GLOBAL`.

**Absence is a value, never null or an error.** An unknown event returns zeros;
`events` returns `[]`; `updatesRejected` returns `0`. Every one of those return
types is non-null.

⏱ If JS resolvers eat more than 30 minutes, switch all four to a single Lambda
resolver with a `switch` on `info.fieldName`. Decide at the 30-minute mark rather
than hoping — it is also easier to talk through in the interview.

**Settings that are easy to get wrong and expensive to notice late:**

- **AppSync API key expiry — set ~365 days.** The default is 7. It must still work
  when they grade it.
- **⚠ `reservedConcurrentExecutions` cannot be set in this account as it stands.**
  Measured 2026-09-20: the account's Lambda *Concurrent executions* quota is **10**,
  all of it unreserved, shared with six other production functions in this region.
  AWS refuses any reservation that would leave fewer than 100 unreserved, so `25` —
  or any value — fails at deploy. Two ways out, and it is a decision, not an
  oversight: raise the quota (`L-B99A9384`, adjustable, no request currently open)
  and then reserve 25; or ship without a reservation and record it as a concession.
  The risk is real either way: a bursting harness can consume all 10 and throttle
  the other workloads, which have no reservation of their own.
- **CloudFront uses OAC**, `S3BucketOrigin.withOriginAccessControl` — not the legacy
  OAI. Private bucket, `DefaultRootObject: index.html`, redirect to HTTPS.
- **TTL enabled on `expiresAt`** so rejection records age out (7 d).
- Page config via `BucketDeployment` + `Source.jsonData('config.json', {url, apiKey})`
  — the page reads it at runtime, nothing is hardcoded. Invalidate on deploy.
- Target Lambdas at `NODEJS_20_X` to match the local Node that bundles them.

**Observability:**

- Powertools Logger with `appendKeys({ eventId, bib, revision, outcome, requestId })`
  — enough to trace one bib end to end.
- Powertools Metrics (EMF): `UpdatesAccepted`, `UpdatesIgnored`, `UpdatesRejected`,
  `TransactionConflicts`. **No per-event or per-bib dimensions** — unbounded
  cardinality.
- Alarm on Lambda `Errors >= 1` → SNS. Optionally a metric-math alarm on
  rejected ÷ total > 0.5.

```
// ❌ alarms on raw rejected count — the brief says ~10% corrupt is NORMAL,
//    so this fires on every run and gets muted, which is worse than no alarm
new cw.Alarm(…, { metric: updatesRejected, threshold: 1 })
```

Use `TreatMissingData.NOT_BREACHING`.

## Outputs

- `lib/pv4-timing-stack.ts` — the single stack, tagged `project=pv4`.
- `schema.graphql` — schema-first, loaded with `Definition.fromFile`.
- CfnOutputs for the ingest URL, AppSync URL, API key and CloudFront URL. These are
  the four things the submission asks for; printing them from the stack beats
  hunting the console weeks later.

**Teardown:** `cdk destroy Pv4TimingStack` — never a bare `cdk destroy`, and never
delete `CDKToolkit`, which is shared. Leave the stack up until they confirm.

# lib/ — CDK infrastructure

Last updated: 2026-09-21

Everything AWS: the table, the ingest Lambda and HTTP route, AppSync, the
CloudFront/S3 page, and observability. One stack, `Pv4TimingStack`.

## Inputs

| Read | For |
|---|---|
| `../CLAUDE.md` | Naming, teardown rule, the counting invariant |
| `../src/CONTEXT.md` | Table layout — it is defined there, built here |
| `../DECISIONS.md` | Decisions already settled |

## Process

**Resolved 2026-09-20 — the stack is `Pv4TimingStack`.** `cdk init` named it
`CandidateBriefTestStack` after the folder; it was renamed before the first
deploy, because renaming a deployed stack destroys and recreates it. The files
are `bin/pv4-timing.ts` and `lib/pv4-timing-stack.ts`. Nothing here is named
after the folder any more.

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
summing the `STATS#` rows and counting the `BIB#` items in the response ·
`updatesRejected` = Query on PK `GLOBAL`, summing its `STATS#` rows.

**Absence is a value, never null or an error.** An unknown event returns zeros;
`events` returns `[]`; `updatesRejected` returns `0`. Every one of those return
types is non-null.

**Resolved 2026-09-20 — one Lambda resolver, not APPSYNC_JS.** All four fields
are served by `src/queryHandler.ts`, switching on `info.fieldName`, wired at
`lib/pv4-timing-stack.ts:146-153`. It was chosen rather than fallen back on:
APPSYNC_JS resolvers would be the only untyped code here and testable only by
calling AWS. Reasons in full at the top of `src/queryHandler.ts`.

**Settings that are easy to get wrong and expensive to notice late:**

- **AppSync API key expiry — set ~365 days.** The default is 7. It must still work
  when they grade it.
- **⚠ `reservedConcurrentExecutions` — the constraint that forced it off has
  since lifted. Re-measure before repeating the old reasoning.**
  - *Measured 2026-09-20:* the account's Lambda *Concurrent executions* quota
    (`L-B99A9384`) was **10**, all unreserved, shared with six other production
    functions in this region (`lade-prod-*`). AWS refuses any reservation that
    would leave fewer than 100 unreserved, so `25` — or any value — failed at
    deploy. The stack shipped without a reservation and recorded it as a
    concession in `DECISIONS.md`.
  - *Measured 2026-09-21:* the quota now reads **1000** — which is also the AWS
    default — with **1000 unreserved** (`aws lambda get-account-settings`,
    `aws service-quotas get-service-quota --quota-code L-B99A9384`). The increase
    request raised on 2026-09-20 still reports `CASE_OPENED`. Whether that
    request was applied and its status lags, or a new-account soft limit was
    lifted separately, is not distinguishable from the CLI; the applied value is
    what binds either way.
  - **Consequence:** a reservation is now settable, and the concession in
    `DECISIONS.md` describes a constraint that no longer binds. Deploying one is
    a live change to a stack that is under assessment, so it is a decision for
    whoever is submitting, not a tidy-up. The risk the concession described —
    a bursting harness consuming the whole account and throttling the
    `lade-prod-*` workloads, which have no reservation of their own — is what
    the reservation would buy back.
- **CloudFront uses OAC**, `S3BucketOrigin.withOriginAccessControl` — not the legacy
  OAI. Private bucket, encrypted and SSL-only, `DefaultRootObject: index.html`,
  redirect to HTTPS, and `CACHING_DISABLED`: the page re-queries on demand, so a
  cached HTML would serve a stale page after a deploy.
- **Explicit `LogGroup`s, never the `logRetention` property.** That one is
  deprecated and implements retention with a custom-resource Lambda — a second
  function, and three extra resources, for something a `LogGroup` declares
  directly. It was an outright blocker when the account was capped at 10
  concurrent executions; it is still not worth the resources. Both groups are
  declared with `ONE_WEEK` retention and destroyed with the stack.
- **TTL enabled on `expiresAt`** so rejection records age out. **30 days, not 7**
  (`src/reject.ts:33`): the brief asks for the payload to be retrievable
  afterwards and the review may be weeks after submission.
- Page config via `BucketDeployment` + `Source.jsonData('config.json', {url, apiKey})`
  — the page reads it at runtime, nothing is hardcoded. Invalidate on deploy.
- **Both Lambdas run `NODEJS_22_X`.** Node 20 was deprecated 2026-04-30 and CDK
  warns at synth. The runtime does not have to match the local Node: esbuild's
  output target is independent of the version bundling it.

**Observability:**

- Powertools Logger, with the trace context passed **per call**, not through
  `appendKeys` (`src/handler.ts:80-83`). Persistent keys survive a warm
  invocation, so a later request for a different athlete would carry the
  previous one's bib — a trace pointing at the wrong athlete is worse than none.
  An accepted or ignored line carries `requestId`, `eventId`, `bib`, `revision`,
  `status` and `outcome` — enough to follow one bib end to end. A rejection
  carries `requestId`, `outcome` and `failedChecks`, because a corrupt payload
  may not have a bib to log.
- Powertools Metrics (EMF): `UpdatesAccepted`, `UpdatesIgnored` and
  `UpdatesRejected` — one per outcome, and nothing else (`src/handler.ts:72,89`).
  **No per-event or per-bib dimensions** — unbounded cardinality turns a free
  metric into a growing bill, and those values are already in the logs.
- One alarm, `pv4-ingest-errors`: the ingest function's `Errors >= 1` over a
  one-minute period, actioned to the `pv4-alarms` SNS topic
  (`lib/pv4-timing-stack.ts:205-217`). No metric-math alarm on the rejection
  rate was built — it was considered and left out.

```
// ❌ alarms on raw rejected count — the brief says ~10% corrupt is NORMAL,
//    so this fires on every run and gets muted, which is worse than no alarm
new cw.Alarm(…, { metric: updatesRejected, threshold: 1 })
```

Use `TreatMissingData.NOT_BREACHING`.

## Outputs

- `lib/pv4-timing-stack.ts` — the single stack. The `project=pv4` tag is applied
  app-wide in `bin/pv4-timing.ts:10`, so every resource inherits it.
- `schema.graphql` — schema-first, loaded with `Definition.fromFile`.
- CfnOutputs for the ingest URL, AppSync URL, API key and CloudFront URL. These are
  the four things the submission asks for; printing them from the stack beats
  hunting the console weeks later.

**Teardown:** `cdk destroy Pv4TimingStack` — never a bare `cdk destroy`, and never
delete `CDKToolkit`, which is shared. Leave the stack up until they confirm.

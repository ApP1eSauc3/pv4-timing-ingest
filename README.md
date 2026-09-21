# PV4 timing ingest

Ingest-and-read pipeline for live competition timing updates, defined entirely in
AWS CDK (TypeScript) and deployed to AWS.

```
POST /timing  ──▶  processor  ──▶  DynamoDB  ──▶  AppSync (GraphQL)  ──▶  CloudFront page
```

The timing feed delivers at-least-once, out of order, and roughly one update in
ten is corrupt. None of that is treatable as a bug to be fixed upstream, so the
processor stays correct anyway: a duplicate applies once, a lower revision never
overwrites a higher one, and a corrupt payload is rejected and counted without
blocking anything behind it.

[`DECISIONS.md`](./DECISIONS.md) covers the design, the concessions and the
measured evidence. This file covers what it is and how to run it.

---

## Deployed endpoints

| | |
|---|---|
| Ingest URL | `https://97uk7xkh26.execute-api.ap-southeast-2.amazonaws.com/timing` |
| AppSync GraphQL URL | `https://v4tz5wuyl5gqvb5pl6msz7r6iq.appsync-api.ap-southeast-2.amazonaws.com/graphql` |
| AppSync API key | `da2-jhxc54srifcidc7kjtkiocak5m` |
| Results page | `https://d264dekl0xqfqc.cloudfront.net` |

The API key is read-only and is meant to be shared — the read Lambda behind it is
granted read access to the table and nothing else, so no query can change a
result. It expires 365 days after deployment.

---

## Try it

```bash
export INGEST_URL="https://97uk7xkh26.execute-api.ap-southeast-2.amazonaws.com/timing"
export GQL_URL="https://v4tz5wuyl5gqvb5pl6msz7r6iq.appsync-api.ap-southeast-2.amazonaws.com/graphql"
export GQL_KEY="da2-jhxc54srifcidc7kjtkiocak5m"

post() { curl -s -X POST "$INGEST_URL" -H 'content-type: application/json' -d "$1"; echo; }
```

**A well-formed update is applied.**

```bash
post '{"eventId":"DEMO","bib":"AUS-1147","lane":3,"revision":1,
       "status":"PROVISIONAL","timeMs":10105,"recordedAt":"2026-08-25T19:42:07.000Z"}'
# {"outcome":"ACCEPTED"}
```

**The same update again is applied once and counted as ignored.** Idempotency and
ordering are the same rule, so a duplicate and a stale revision look identical to
the processor.

```bash
post '{"eventId":"DEMO","bib":"AUS-1147","lane":3,"revision":1,
       "status":"PROVISIONAL","timeMs":10105}'
# {"outcome":"IGNORED"}
```

**A higher revision wins, whatever status it carries.** This is the jury case: a
protest is upheld, an `OFFICIAL` result is reopened, and the scoreboard has to
follow it backwards.

```bash
post '{"eventId":"DEMO","bib":"AUS-1147","lane":3,"revision":2,"status":"OFFICIAL","timeMs":10102}'
# {"outcome":"ACCEPTED"}
post '{"eventId":"DEMO","bib":"AUS-1147","lane":3,"revision":3,"status":"PROVISIONAL","timeMs":10102}'
# {"outcome":"ACCEPTED"}  — status moved backwards, revision did not
```

**A corrupt payload is rejected, and says why.** Every failing rule is reported,
not just the first, and the payload itself is stored so it can be looked at later.

```bash
post 'not json'
# {"outcome":"REJECTED","failedChecks":["body_isJson"]}

post '{"eventId":"DEMO","bib":"","lane":"3","revision":0,"status":"official","timeMs":-5}'
# {"outcome":"REJECTED","failedChecks":["bib_nonEmptyString","lane_int32",
#   "revision_int32Gte1","status_knownValue","timeMs_int32Positive"]}
```

**Read it back.**

```bash
curl -s -H "x-api-key: $GQL_KEY" -H 'content-type: application/json' \
  -d '{"query":"{ events results(eventId:\"DEMO\"){ bib lane revision status timeMs } eventStats(eventId:\"DEMO\"){ athletesTracked updatesAccepted updatesIgnored } updatesRejected }"}' \
  "$GQL_URL"
```

---

## How it works

### The request path

| Step | Where | What happens |
|---|---|---|
| 1 | HTTP API | `POST /timing` is the only route. Anything else is a 404 and never reaches the processor |
| 2 | `handler.ts` | decode → size check → parse → validate. Nothing touches the database until validation passes |
| 3 | `applyValid.ts` | One conditional `TransactWriteItems`: the result, the accepted counter and the event registry, together or not at all |
| 4 | `applyValid.ts` | Classify the outcome. A failed condition is `IGNORED`; a write collision is retried; anything else throws |
| 5 | response | `200 {"outcome":"ACCEPTED"}` or `{"outcome":"IGNORED"}`; `400 {"outcome":"REJECTED", …}`; or a 5xx that counts nothing |

### Ordering and idempotency are one condition

```
attribute_not_exists(revision) OR revision < :rev
```

If it holds, the update is newer and overwrites. If it fails, what is stored was
already at least as new — which is what a duplicate and a late arrival both look
like. There is no separate deduplication anywhere in this codebase.

The condition never mentions `status`. That is what lets revision 4 `PROVISIONAL`
replace revision 3 `OFFICIAL`.

### The table

One DynamoDB table, on-demand, with TTL on `expiresAt`.

| PK | SK | Holds |
|---|---|---|
| `EVENT#<eventId>` | `BIB#<bib>` | bib, lane, revision, status, timeMs, recordedAt, updatedAt |
| `EVENT#<eventId>` | `STATS#<0-24>` | updatesAccepted, updatesIgnored |
| `EVENTS` | `<eventId>` | firstSeenAt |
| `GLOBAL` | `STATS#<0-24>` | updatesRejected |
| `REJECTED` | `<receivedAt>#<uuid>` | rawBody, failedChecks, requestId, receivedAt, expiresAt |

The counters share a partition key with every athlete on purpose: one Query
returns both, so `athletesTracked` is **counted from the rows** rather than stored
as a number that can drift from the athletes it claims to count.

Counters are spread over 25 rows and summed on read. That came out of load
testing, not the plan — on a single row, updates for unrelated athletes collided
with each other.

### Counting

Every update that reaches the processor lands in exactly one of
`updatesAccepted`, `updatesIgnored` or `updatesRejected`. A 5xx is deliberately
not a fourth bucket: it means the outcome is unknown, nothing is counted, and the
feed re-sends.

`updatesAccepted` and `updatesIgnored` are per event. `updatesRejected` is
pipeline-wide, because a corrupt payload may not say which event it belonged to.

### Validation

Strict by construction — a field is valid only if it is positively valid, so
`"3"`, `3.5`, `"official"`, `null` and a missing field are all corrupt.
`recordedAt` is stored but never validated and never ordered on, because it comes
from timing hardware whose clock is not trustworthy.

Bodies over 64 KB are rejected before parsing. Rejection records keep the payload
for 30 days, truncated at 300 KB.

---

## The read API

The contract from the brief, exactly as specified, with a test asserting every
line of it still exists:

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

All four fields are served by one Lambda switching on `info.fieldName`, rather
than AppSync's JavaScript resolvers. **Absence is a value, never null and never an
error:** an unknown event returns zeros, `events` returns `[]`.

---

## The results page

A static page on S3 behind CloudFront, no build step. It asks the API which
events exist rather than having one written into it, shows the selected event's
results and counters, and re-queries without a reload.

The endpoint and key come from a `config.json` written at deploy time, so nothing
is baked into the HTML and the same page works against any deployment. A failed
read is never mistakable for an event with no results — an expired key is named
specifically, and any other failure clears the table and says so.

---

## Observability

| | |
|---|---|
| Logs | Structured JSON via Powertools. An accepted or ignored line carries `requestId`, `eventId`, `bib`, `revision`, `status` and `outcome` — enough to trace one athlete end to end. Retained one week |
| Metrics | `UpdatesAccepted`, `UpdatesIgnored`, `UpdatesRejected` in namespace `PV4/Timing`, published as EMF. No per-event or per-athlete dimensions: unbounded cardinality turns a free metric into a growing bill |
| Alarm | `pv4-ingest-errors` — the ingest function's `Errors >= 1` over one minute, to the `pv4-alarms` SNS topic |

The alarm watches errors rather than rejections on purpose. Roughly one update in
ten arrives corrupt, so an alarm on rejections fires every race and gets muted,
which is worse than no alarm. An error means the processor could not say what
happened to an update, which should never happen.

**The SNS topic has no subscription in CDK**, because an email address does not
belong in a public repo. To receive alarms:

```bash
aws sns subscribe --topic-arn <the pv4-alarms topic ARN> \
  --protocol email --notification-endpoint <your address> --region ap-southeast-2
```

---

## Repository layout

```
bin/    CDK app entry, and the project=pv4 tag applied app-wide
lib/    the stack, and the GraphQL schema
src/    the processor — validation, ordering, writes, and the read API
test/   unit tests, stack tests, the template snapshot, and the deployed harness
web/    the results page
docs/   working notes behind DECISIONS.md
```

Each of `lib/`, `src/` and `docs/` carries a `CONTEXT.md` describing the contract
for that area.

---

## Running it yourself

**Prerequisites:** Node 20 or newer, and AWS credentials for an account you are
happy to deploy into. The Lambdas run Node 22; the version bundling them does not
have to match, because esbuild's output target is independent of it.

```bash
npm install
npx cdk bootstrap            # once per account + region
npx cdk deploy Pv4TimingStack
```

The four URLs above are printed as stack outputs, so they never have to be hunted
for in the console.

Nothing in this repo is secret. The AWS account id is read from the environment at
synth time and never written down; the AppSync key is meant to be shared.

---

## Testing

```bash
npm test           # 84 tests: unit, stack assertions, template snapshot
npm run snapshot   # re-record the stack snapshot after an intended change
```

Four layers, each catching something the others cannot.

| Layer | Tests | What it catches |
|---|---|---|
| Pure functions | `validate` 29, `decide` 8, `shapeStats` 8 | The ordering rule against all 720 arrival orders of six revisions; every corrupt variant of every field rule |
| Stack assertions | `pv4-timing` 15, `stack-assertions` 9 | Decisions cheap to get wrong and expensive to notice late — only the ingest function can write, the alarm notifies something, the key outlives the assessment, every submission URL is an output |
| Schema | `schema` 14 | One test per line of the contract the graders' harness runs against |
| Template snapshot | `stack-snapshot` 1 | Any change at all to the synthesized stack — including the one nobody thought to assert on |

The stack tests were checked by breaking the stack on purpose, one change at a
time, until each was seen to fail. A test that has never failed is not yet
evidence of anything.

**The deployed harness** runs against a real stack rather than a mock, because
every real bug in this project was found there and not locally:

```bash
INGEST_URL=... GQL_URL=... GQL_KEY=... npm run harness
```

It sends 200 updates across 8 athletes — shuffled, ~20% duplicates, ~10% corrupt,
five requests in flight — then fires six revisions at one athlete simultaneously,
twenty times over. It asserts both that the counters balance and that every
athlete ended at their highest revision, because balanced is not the same as
correct.

It writes to whatever stack you point it at, under a fresh event id per run.

---

## Teardown

```bash
npx cdk destroy Pv4TimingStack
```

Always name the stack. Never run a bare `cdk destroy`, and never delete the
shared `CDKToolkit` stack.

# DECISIONS

PV4 timing ingest — RWS Global technical assessment.

**Time spent:** 4 hours 30 minutes

---

## 1. Known concessions

These are deliberate trade-offs rather than missed requirements.

**Updates rejected before Lambda cannot be counted.** “Received” means requests that reach the processor. API Gateway rejections, such as malformed requests or bodies over its 10 MB limit, never reach any of the three buckets.

**No reserved concurrency on the ingest Lambda.** The account's concurrency quota is 10, while AWS requires at least 100 unreserved concurrency for a reservation. A sustained burst can therefore be throttled before processing. I requested a quota increase; it was still pending at submission.

**The ignored counter is a second write.** The original transaction has already been cancelled when the condition fails, so `updatesIgnored` requires another call. A crash between the two can leave the counter one short if the feed never retries. A retry does not double-count because the condition fails again.

**`events` grows with events seen.** It uses a paginated Query rather than a scan, but a long-lived production system would want a date prefix or pagination in the contract.

**The alarm has no confirmed subscriber.** CloudWatch and SNS are configured and the alarm is armed, but the subscription remains `PendingConfirmation`. I did not put the email in CDK because it does not belong in a public repository. The README contains the command to complete the subscription.

The alarm itself watches Lambda errors rather than normal conditional-write races, and its metric and structured logs remain queryable regardless of email delivery.

**A changed lane is stored rather than rejected.** The brief says the lane is fixed but gives no behaviour for a change, so I store the latest applied value rather than inventing a rule.

---

## 2. How it works, and why

### Ordering and idempotency

Both are enforced by the same DynamoDB condition:

```text
ConditionExpression: attribute_not_exists(revision) OR revision < :rev
```

A newer revision replaces the stored value. Equal or lower revisions are ignored, so duplicates and late arrivals require no separate deduplication mechanism.

The condition deliberately ignores status. Therefore revision 4 `PROVISIONAL` can replace revision 3 `OFFICIAL`, as required when a protest changes the result.

The deployed worked example produces the expected final state: revision 4 `PROVISIONAL`, three accepted and three ignored. Revision 3 `CONFIRMED` arriving after revision 3 `OFFICIAL` is ignored because the revision is not greater.

`src/decide.ts` implements the same rule as a pure function and is tested against all 720 arrival orders of six revisions. The processor does not use it for the actual decision: reading before writing would allow concurrent Lambdas to make the same decision. DynamoDB's conditional write must remain authoritative.

### Validation

Validation happens before any write: size check, parsing, then field-by-field validation. Invalid input therefore cannot create an athlete, and each request is isolated from others.

Validation is positive and strict: `"3"`, `3.5`, `"official"`, `null`, and missing fields are invalid. All failures are collected and their rule names stored on the rejection.

The rejection payload and `updatesRejected` counter are written in one transaction so they cannot diverge.

### Counting

Every update reaching the processor is either accepted, ignored, or rejected. A 5xx is deliberately not a fourth bucket: it means the outcome is unknown, nothing is counted, and the feed retries.

`athletesTracked` is calculated from athlete rows rather than stored as a counter. The athletes and counters share a partition key, so one Query retrieves the required data without introducing another mutable source of truth.

### Load testing

The deployed harness sends 200 updates across 8 athletes with shuffled ordering, ~20% duplicates, ~10% corrupt payloads and five concurrent requests. It checks both counter balance and final revision correctness.

The initial runs exposed three issues:

1. DynamoDB could report transaction collisions through two exception types; only one was handled.
2. The ignored-counter write had no retry.
3. All updates incremented one counter row, creating unnecessary contention between unrelated athletes.

The final design centralises retry handling and spreads counters across rows, aggregating them on read.

```text
3 retries, one counter row           20/200 failed
collision exception handled          34/200 failed
both accept paths guarded              2/200 failed
counters spread over 25 rows           1/200 failed
final implementation                   0/200 failed — three runs
```

Importantly, none of the failures produced an incorrect count. They returned 5xx and remained outside the buckets, which is the intended behaviour.

The concurrency case was also run independently: six revisions for one athlete fired simultaneously for twenty rounds. The final state was revision 6 every time, with accepted + ignored equal to the number sent.

### Testing

Four layers cover different failure modes:

* **Pure functions:** exhaustive ordering tests and validation variants.
* **Stack assertions:** IAM permissions, alarm actions, API-key lifetime, concurrency configuration and submission outputs.
* **Template snapshot:** catches unexpected synthesized-stack changes; generated asset hashes and key expiry are scrubbed.
* **Deployed harness:** exercises the real AWS stack and found every runtime bug.

I deliberately broke the stack to verify the assertions: granting the read API write access, removing the alarm action, changing log retention and pointing the alarm at rejections were all caught.

There are no handler unit tests. Mocking DynamoDB would test the mock rather than the real transaction behaviour; the deployed harness provides that coverage.

### Alternatives considered

**SQS:** The conditional write already provides idempotency. A queue would add redelivery semantics and potentially require a receipt ledger to distinguish retries from duplicates. It would become worthwhile if bursts approached DynamoDB write limits or the venue required network decoupling.

**Powertools Idempotency:** It deduplicates payloads and returns cached responses, which would make feed duplicates invisible to `updatesIgnored`. That solves a different problem from the brief.

**Amplify `_version`:** The timing system owns revision ordering, so a store-generated version would introduce a second ordering source.

**Separate deduplication table:** Another source of truth, and it would swallow duplicates that the brief requires us to count.

**Stored `athletesTracked`:** Cheaper to read but vulnerable to drift under concurrency. Deriving it from rows keeps the value authoritative.

**AppSync JavaScript resolvers:** My first plan. The rest of the project is TypeScript and locally testable; `APPSYNC_JS` would introduce an untyped, AWS-dependent test path for a small amount of shaping logic. The Lambda adds a cold start but is immaterial at the expected race volume.

### Settled decisions

| Question                          | Decision                          | Why                                                           |
| --------------------------------- | --------------------------------- | ------------------------------------------------------------- |
| Edge rejection: 400 or 422?       | 400                               | Either is defensible; the counting semantics matter more      |
| Non-JSON, empty or array body     | Corrupt; raw body stored          | May have no `eventId`, so rejection counting is pipeline-wide |
| Unknown fields                    | Accepted, then dropped            | Corruption is defined field-by-field                          |
| Whitespace-only `eventId` / `bib` | Corrupt                           | Non-empty means genuinely non-empty                           |
| Surrounding whitespace            | Trimmed before storage            | Prevents duplicate athlete rows                               |
| `lane` bounds                     | Any 32-bit integer                | The brief only requires an integer                            |
| `timeMs: 10105.0`                 | Accepted                          | JSON parsing cannot distinguish it from `10105`               |
| Integer bounds                    | Reject above 2³¹−1                | Required by GraphQL `Int`                                     |
| Oversized body                    | Reject above 64 KB before parsing | Avoids unnecessary parsing work                               |
| Handler unit tests                | None                              | Real DynamoDB behaviour is covered by the deployed harness    |
| SDK retry attempts                | 1                                 | Keeps retry behaviour centralised in `src/retry.ts`           |
| Rejection TTL                     | 30 days                           | Review may occur weeks after submission                       |
| Unknown event                     | Zeros, `[]`, and `0`              | Schema fields are non-null                                    |
| Metric dimensions                 | None per event/athlete            | Avoids unbounded CloudWatch metric cardinality                |

---

## 3. AI assistance

I used Claude Code throughout for boilerplate and reviewed every generated line before committing or deploying.

**Claude-generated:** CDK stack in `lib/`, `bin/` entry point, results page, deployed harness and fixtures, stack assertions and snapshot tests, snapshot recorder, `CLAUDE.md`, and `CONTEXT.md`.

**Written by me:** everything in `src/`, including `validate.ts`, `decide.ts`, `applyValid.ts`, transaction/classification logic, `retry.ts`, `reject.ts`, `db.ts`, both handlers, `schema.graphql`, pure-function tests, file headers and this document.

The split was deliberate: the processor rules and counting logic are the assessment, while the CDK wiring, UI and harness are mechanical. Writing the latter quickly left time for the deployed load testing that found the real bugs.

My first transaction implementation contained an unused expression value that DynamoDB rejected; every POST returned 500 until I deployed it. The collision bugs described above were also found through the deployed harness.

Claude's generated stack also used a deprecated Node runtime and `logRetention`, which creates another Lambda. Both were caught by `cdk synth` before deployment.

I did not write the stack assertion tests, so I deliberately broke the stack afterwards to verify that each test actually failed when its condition was violated.

**The main lesson:** verify against the deployed system, not just the code as it reads.

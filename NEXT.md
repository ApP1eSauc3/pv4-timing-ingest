# If given more time

Written 2026-09-21, after submission. This is what I would fix next, including issues a reviewer would reasonably raise.

Nothing here is implemented except the ingest-volume alarm, marked *Committed 2026-09-21, not deployed*. The submitted processor, counting and read contract are unchanged.

Where relevant, I link the external specification or name the code location.

---

## 1. Correctness

**Bound revision jumps.** Validation rejects malformed revisions, but not absurdly large valid ones (`src/validate.ts:27,57`). A corrupt `revision: 2000000000` would be accepted and would effectively freeze that athlete for the rest of the meet.

I would reject revisions more than a configured step above the stored value, using a `ConditionCheck` in the same transaction rather than a separate read.

**Keep an append-only history.** Results currently overwrite the latest-state row, leaving no audit trail for protests or corrections. I would write each accepted update to a history item in the same transaction and keep the current row as the read model.

This matches the ODF model, where messages are versioned, complete records that replace the previous version. [ODF Foundation Principles](https://odf.olympictech.org/2020-Tokyo/general/HTML/foundation/Foundation_Principles_body.htm)

**Add an operator override.** Provide a recorded way to reset or force an athlete's revision rather than editing DynamoDB manually. Corrections belong in the protocol and in the history.

**Fix the ignored-counter gap.** Already disclosed in `DECISIONS.md`: the ignored counter is a second write after the transaction is cancelled, so a crash between the two can leave it one short.

`ClientRequestToken` does not solve this. It only makes `TransactWriteItems` idempotent for ten minutes, and the counter update is a separate `UpdateItem`. [DynamoDB transactions](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis.html)

I would make the counter write its own transaction: condition on the stored revision still being at least the incoming revision, then increment with a token derived from `(eventId, bib, revision)`. Whether the extra write is worthwhile depends on the actual resend interval.

**Decide on lane changes.** The brief fixes lane and gives no behaviour for changes. I would at least log unexpected changes at `warn` and expose a metric. I would not reject them, because lane is not the ordering signal.

---

## 2. Testing

**Test the handler against DynamoDB Local.** This is the critique I would most expect and agree with. The real bugs are in the write path, and mocks cannot prove the DynamoDB failure semantics.

Both contention shapes need coverage:

* `TransactionConflictException` for item-level contention.
* `TransactionCanceledException` with positional `CancellationReasons` for transaction failures.

AWS does not retry the latter, and this client already pins `maxAttempts: 1` (`src/db.ts:38`), which makes `src/retry.ts` the only retry policy. `src/applyValid.ts:39,50,59` distinguishes the cases without tests proving it. [DynamoDB transactions](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis.html)

**CI on every push.** Run `npm test` in GitHub Actions. Unit tests, stack assertions and the template snapshot all run offline in about 13 seconds.

**Heavier load testing.** The current three 200-update runs at five concurrent requests come to only 600 requests. I would test higher, burstier concurrency and report failure rates with sample sizes.

A 5xx is still safe, because it is counted in no bucket and the feed re-sends. The useful metric is how often that happens.

---

## 3. Operations

**Protect the ingest endpoint.** It is public and unauthenticated. Anyone who reads this repository can post timing updates to it.

That is acceptable for the assessment because graders need to reach it. For real use: IAM auth or a shared secret, throttling and a WAF rate-based rule.

The Lambda account concurrency quota was 10 when this was built, which made an open endpoint particularly concerning. It is now 1000, with 1000 unreserved, so that specific risk has changed, but the endpoint should still be protected.

**Ingest-volume alarm, committed 2026-09-21, not deployed.** `pv4-ingest-volume` watches invocation count and alerts at 2000 over five minutes via the existing SNS topic.

I chose detection over API Gateway throttling because throttled requests return 429 before reaching the processor and therefore disappear from all three counters. [API Gateway throttling](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-throttling.html)

**Alarm on contention.** DynamoDB exposes `TransactionConflict`. It should be monitored because rising conflicts are the early signal that the 25 counter shards are no longer enough. [DynamoDB transactions](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis.html)

**Mark test traffic.** Add an explicit test/production flag so harness traffic can never mix with real results. Fresh event IDs keep counters honest today, but do not distinguish the events themselves.

**Confirm the SNS subscription.** The topic currently has no confirmed subscriber, so the alarm notifies nobody.

---

## 4. Production path

**Richer event identity.** `eventId` is opaque. ODF identifies results using an RSC code containing discipline, gender, event, phase and unit. Event plus phase would avoid relying on upstream disambiguation. [ODF Foundation Principles](https://odf.olympictech.org/2020-Tokyo/general/HTML/foundation/Foundation_Principles_body.htm)

**Validate at the source.** Real timing systems use redundant timing and official sign-off. ODF also has a richer `ResultStatus` progression than this brief. Ingest validation should remain the backstop, not the primary defence.

ODF orders versions using a monotonic `Version`, separate from result status, which is the same separation used here.

**Add a queue when volume justifies it.** Put SQS or a stream in front of the processor once bursts approach DynamoDB limits or the venue needs network decoupling.

A DynamoDB transaction consumes capacity for every item twice and still consumes it when cancelled, so ignored duplicates are not free. The conditional write remains authoritative either way.

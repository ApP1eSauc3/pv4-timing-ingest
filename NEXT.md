# If given more time

Written 2026-09-21, after submission. Nothing below is implemented; the submitted
design is unchanged. This is a list of what I would do next and why, including
the things a reviewer would be right to raise.

Where a claim rests on someone else's specification, it is linked. Where it rests
on this codebase, the file and line are named.

---

## 1. Correctness

**Bound revision jumps.** This is the gap I would fix first, and it is the one
the brief does not ask about. Validation rejects malformed payloads, not wrong
ones: `revision` must be an integer between 1 and 2,147,483,647
(`src/validate.ts:27,57`), so a revision garbled to 2,000,000,000 is well-formed
and is applied. Every genuine update for that athlete is then ignored, because
4 is not greater than 2,000,000,000.

The lockout is not literally permanent — 147,483,647 values above the poisoned
one would still be accepted — but no timing system will ever send one, so in
practice that athlete is frozen for the rest of the meet. At roughly one update
in ten arriving corrupt, some of that corruption will be shape-valid.

I would reject any revision more than a configured step above the stored value
and count it as rejected. That needs a read before the write, which the design
deliberately avoids, so it belongs as a `ConditionCheck` in the same transaction
rather than a separate `GetItem` — the condition becomes "greater than stored,
and not more than N greater".

**Keep an append-only history.** Results are overwritten in place, so there is no
audit trail for a protest and no way to see what a poisoned revision replaced. I
would write each accepted update to a history item in the same transaction,
keeping the latest-state row as the read model.

This is also how the Olympic Data Feed treats results: messages are versioned
rather than mutated, and "results related messages are always full and complete
messages and always replace the previous version"
([ODF Foundation Principles](https://odf.olympictech.org/2020-Tokyo/general/HTML/foundation/Foundation_Principles_body.htm)).
The current state is a projection; the messages are the record.

**Add an operator override.** A way to reset or force one athlete's revision,
recorded in the history, so recovery never means editing DynamoDB by hand. ODF
has a precedent worth copying: an erroneous message is corrected by sending an
empty message with a matching header, and a `Note` element carries free-text
explanation of why a result changed. Corrections are part of the protocol rather
than an out-of-band repair.

**Revisit the ignored-counter gap.** Already disclosed in `DECISIONS.md`: the
increment is a second write, because the transaction it belonged to has already
been cancelled, and a crash between the two leaves `updatesIgnored` one short.

I would not claim `ClientRequestToken` closes it. That token makes a
`TransactWriteItems` call idempotent for ten minutes after it finishes
([DynamoDB transactions](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis.html)),
and the ignored-counter write is a plain `UpdateItem` outside any transaction.
The increment also cannot be folded into the original transaction, because it
must happen *because* that transaction was cancelled.

What would genuinely help: make the second write a `TransactWriteItems` of its
own — a `ConditionCheck` that the stored revision is still at least the incoming
one, plus the counter `Update` — with a client token derived from
`(eventId, bib, revision)`. A re-send inside ten minutes then counts once even if
the first attempt's outcome was never observed. Outside ten minutes it is counted
again on a path where today it is not counted at all, so the bound changes shape
rather than disappearing. Whether that is worth the extra write is a judgement I
would want to make with a measured re-send interval, not a guess.

**Decide on lane changes.** Currently the latest applied value is stored
silently, because the brief states lane is fixed and gives no rule for what to do
when it is not. A changed lane is far more likely corruption than reality, so I
would at minimum log it at `warn` and surface it as a metric. Rejecting the
update outright would be wrong: the lane is not the ordering signal, and
discarding a newer time because its lane looks odd is the failure the brief
cares about.

---

## 2. Testing

**Handler tests against DynamoDB Local.** This is the critique I would rate most
likely to land, and I agree with it. All three real bugs lived in the write path,
and "mocking tests the mock" only holds for the happy path. A fake that raises a
real `TransactionCanceledException` carrying `CancellationReasons` is not a mock
of my logic — it is the input my logic exists to classify.

Both shapes need covering, because DynamoDB reports contention two different
ways: an item-level rejection raises `TransactionConflictException`, while a
rejection inside a transaction raises `TransactionCanceledException` with a
positional `CancellationReasons` list — and for that second one, AWS SDKs do not
retry the request
([DynamoDB transactions](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis.html)).
This client pins `maxAttempts: 1` anyway (`src/db.ts:38`), so the policy in
`src/retry.ts` is the only one in play.
`src/applyValid.ts:39,50,59` distinguishes them today with no test that proves
it. DynamoDB Local gives real semantics offline, which the deployed harness
cannot do in CI.

**CI on every push.** A GitHub Action running `npm test` — the unit tests, the
stack assertions and the template snapshot. All of it runs offline in about
thirteen seconds, so there is no reason it is not already there except time.

**Heavier load testing.** Three clean runs of 200 updates at five in flight is
600 requests. That bounds the failure rate loosely — below roughly half a percent
at that concurrency — and races are bursty, so it shows contention was low in the
test rather than that it stays low. I would run higher concurrency with bursty
arrival and report failure rates with their sample sizes.

Correctness does not depend on the answer: a 5xx is counted in no bucket and the
feed re-sends. What the number tells you is how often the feed has to.

---

## 3. Operations

**Protect the ingest endpoint.** It is public and unauthenticated — anyone who
reads this repo can post timing updates into it. That is the one weakness the
submitted `DECISIONS.md` does not list, and it should have.

For an assessment it is acceptable, because the graders have to be able to post
to it without credentials. For anything real it would sit behind IAM auth or a
shared secret. In the meantime, stage-level throttling on the HTTP API caps both
the sustained rate and the burst, and returns 429 above it
([API Gateway throttling](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-throttling.html)) —
a few lines of CDK, and it bounds the blast radius without breaking the
assessment. A WAF rate-based rule would add per-IP blocking.

One correction to my own earlier reasoning: the account's Lambda concurrency
quota was 10 when this was built, which is what made an open endpoint alarming.
Measured 2026-09-21 it is 1000, the AWS default, with 1000 unreserved. The
endpoint should still be throttled; the account is no longer one burst away from
starving everything else in the region.

**Alarm on contention, not just on errors.** DynamoDB publishes a
`TransactionConflict` metric that increments per failed item-level request
([DynamoDB transactions](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis.html)).
The stack does not watch it. Rising conflicts are the early signal that the 25
counter shards are no longer enough — the condition that produced every 5xx
during load testing — and unlike a load test it measures the real thing under
real traffic.

**Mark test traffic.** A test-versus-production flag on each update, so harness
runs can never mix with real results. Today the harness uses a fresh event id per
run, which keeps counters honest but still leaves ten `HARNESS-*` events in the
`events` list a grader sees.

**Confirm the alarm subscription.** The SNS topic still has no confirmed
subscriber, so the alarm notifies nobody. One command, in the README, and a
click.

---

## 4. Production path

**Richer event identity.** `eventId` is opaque here. ODF identifies a unit with
an RSC code that encodes "the discipline, gender, event, phase and unit", so a
heat, a semi-final and a final are distinct identities rather than one event id
that something upstream has to disambiguate
([ODF Foundation Principles](https://odf.olympictech.org/2020-Tokyo/general/HTML/foundation/Foundation_Principles_body.htm)).
Keying on event plus phase would match how the rest of the industry addresses
results.

**Validate at the source.** Timing systems handle corruption with redundant
timing — beam plus backup camera — and official sign-off, and ODF carries a
`ResultStatus` progression (`START_LIST`, `INTERMEDIATE`, `LIVE`, `UNCONFIRMED`,
`UNOFFICIAL`, `OFFICIAL`, `PARTIAL`) that is richer than the brief's three
values. Plausibility belongs as close to the hardware as possible. Ingest
validation is the backstop, not the primary defence.

Worth noting that ODF orders on a monotonic `Version` — "sequential number with
the highest indicating the most recent version" — and not on result status,
which is the same decision this processor makes for the same reason. That the
industry standard separates the two is the strongest argument I have that the
design is right.

**Add a queue when volume justifies it.** SQS or a stream in front of the
processor once bursts approach DynamoDB's write limits or the venue needs
decoupling from the network. Worth remembering that a transaction consumes
capacity for every item twice, to prepare and to commit, and consumes it even
when the transaction is cancelled — so an ignored duplicate is not free. The
conditional write stays authoritative either way.

---

## What I would not change

The conditional write. Every alternative considered in `DECISIONS.md` adds a
second source of truth, and the one place the industry standard is explicit —
order on a monotonic version, never on status — is the place this design already
agrees with it.

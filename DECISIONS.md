# DECISIONS

PV4 timing ingest — RWS Global technical assessment.

Time spent: _TBD — fill this in before submitting_

---

## 1. Known concessions

I would rather list these than claim the solution is complete, because every one
of them is something I decided to live with rather than something I missed.

**Updates that never reach the processor cannot be counted.** "Received" here
means every POST that actually reaches the Lambda. If API Gateway rejects
something before that — a body over its own 10 MB limit, a malformed request —
it lands in none of the three buckets, because nothing of mine ever saw it.

**No reserved concurrency on the ingest Lambda.** This account's Lambda
concurrency quota is 10, and AWS only permits a reservation that leaves at least
100 unreserved, so the reservation I wanted could not be set at all. Under a
sustained parallel burst some requests will be throttled by Lambda before
reaching the processor, and like the case above they cannot be counted. I have
requested an increase; it was still pending when I submitted this.

**The ignored counter is a second write.** When the condition fails, the
transaction it belonged to has already been cancelled, so incrementing
`updatesIgnored` has to be a separate call. If the Lambda dies between the two
and the feed never re-sends, that count comes up one short. With a re-send the
condition simply fails again and it is counted once, so the exposure is a crash
with no retry at all.

**`events` grows with the number of events ever seen.** It is one Query against
one partition rather than a scan, and it pages, so it is cheap — but for a whole
season rather than a meet it would want a date prefix or pagination in the
contract. Fine for what this is; wrong for something long-lived.

**The alarm has no subscriber, unless I have added one out of band.** The alarm
and its SNS topic are defined in CDK, but a topic with no subscription delivers
nowhere — the alarm would fire into nothing. Subscribing needs an email address,
and an address does not belong in a public repo, so it is a deliberate step
outside the stack rather than part of it. If I have not run it before you read
this, treat the alarm as defined but not delivering.

**A lane that changes between revisions is stored, not rejected.** The brief says
lane is fixed for the race but defines no rule for what to do when it is not, so
I store the latest applied value rather than invent a rule the brief does not ask
for.

---

## 2. How it works, and why

### Ordering and idempotency are the same rule

The part I most want to point at is how small this turned out to be. Both rules
come down to one condition on one write:

```
ConditionExpression: attribute_not_exists(revision) OR revision < :rev
```

If the condition holds, the incoming update is genuinely newer and overwrites
what is stored. If it fails, whatever is already there was at least as new. A
duplicate has the same revision, so the condition fails and it is ignored. A late
arrival has a lower revision, so the condition fails and it is ignored. Both of
the feed's misbehaviours resolve to the same comparison, which means there is no
separate deduplication anywhere in this codebase and no second source of truth to
keep in step.

Notice what the condition never mentions: status. That is what lets revision 4
`PROVISIONAL` replace revision 3 `OFFICIAL` when a jury upholds a protest. A
design that ordered on status would refuse that write and leave the scoreboard
showing a time that had already been overturned, which is exactly the failure the
brief describes.

The worked example from the brief runs against the deployed stack and comes out
exactly as specified — final state revision 4 `PROVISIONAL`, three accepted,
three ignored. Arrival 5 is the interesting one: revision 3 `CONFIRMED` arriving
while revision 3 `OFFICIAL` is stored. Ignored, because 3 is not greater than 3,
whatever status it carries.

`src/decide.ts` states the same rule as a pure function and is tested against all
720 arrival orders of six revisions, but the processor deliberately does not call
it. Deciding in JavaScript would mean reading before writing, and two Lambdas
handling the same athlete could then both read revision 3 and both write. Only
the database can settle that, so the database is where the decision lives. The
pure function exists because it is the only version that can be tested
exhaustively.

### Validation

Everything corrupt is caught before any write happens: size check, then parse,
then field-by-field validation. Consequently a corrupt payload can never create
a phantom athlete, and one bad payload only ever affects its own request — the
updates behind it are unaffected, since each arrives as its own invocation.

Validation is strict by construction. A field is valid only if it is positively
valid, so `"3"`, `3.5`, `"official"`, `null` and a missing field are all corrupt.
Every failing rule is collected rather than stopping at the first, and the names
of those rules are stored on the rejection, so a rejection explains itself
without anyone having to reproduce it.

The rejection record and the rejected counter are written in a single
transaction. Written separately they could disagree — a stored payload nobody
counted, or a count with no payload behind it — and then neither number means
anything.

### Counting

Every update that reaches the processor lands in exactly one of accepted, ignored
or rejected. A 5xx is not a fourth bucket: it means we genuinely do not know what
happened, nothing is counted, and the feed re-sends. That is why any
infrastructure failure throws instead of being quietly filed as "ignored", which
would balance the books with a wrong number.

`athletesTracked` is counted from the athlete rows every time it is asked for,
never stored. The counters and the athletes share a partition key, so one Query
returns both, and a count derived from the rows cannot drift out of step with the
rows themselves the way a stored number eventually would.

### What load testing changed, and how confident I am

Confident, but only because of what the harness found — none of this was visible
in unit tests, and the static checks all passed while the code was broken.

The harness fires 200 updates across 8 athletes at the deployed stack: shuffled,
about 20% duplicates, about 10% corrupt, five requests in flight. It asserts both
that the counters balance and that every athlete ended at their highest valid
revision, because balanced is not the same as correct.

```
3 retries, one counter row           20 of 200 failed
collision exception handled          34 of 200 failed  (the ignored path was unguarded)
both accept paths guarded             2 of 200 failed
counters spread over 25 rows          1 of 200 failed  (the rejection path was unguarded)
rejection path guarded and spread     0 of 200 failed  — three consecutive runs
```

Three problems, all the same problem wearing different clothes:

1. DynamoDB reports a collision through two different exception types, and I was
   only handling one of them. The other went straight to a 5xx with no retry.
2. The ignored counter was written with no retry at all, while touching the
   busiest row in the table.
3. Underneath both, every update for an event was incrementing one row, so
   updates for completely different athletes collided with each other.

The retry policy now lives in one file that every writer shares, and the counters
are spread across rows and added up on read. The tell for the last one was in the
error itself: DynamoDB returns one cancellation reason per item, and the failing
transaction listed two — while the accept path writes three. It was never the
accept path failing at all.

What matters more than any of those fixes: through every one of those failures,
**not one update was ever miscounted**. They all came back as 5xx and landed in
no bucket, which is the designed behaviour. The counters and the stored results
agreed on every single run, including the broken ones. A design that guessed
would have recorded those as "ignored", left results stuck at stale revisions,
and still produced counters that balanced perfectly.

The concurrency case is the one I would point at in an interview: six revisions
for one athlete fired simultaneously, twenty rounds, and the final state is
revision 6 every time. Anything from one to six of them is accepted depending on
which lands first — if the newest wins the race, the other five are correctly
ignored — and accepted plus ignored always equals what was sent.

### Alternatives I considered and discounted

**SQS between the endpoint and the processor.** The conditional write already
makes processing idempotent, so a queue adds no correctness. It does add a
redelivery path: a message redelivered after a successful commit would be counted
as ignored a second time, and avoiding that needs a ledger of receipt ids, which
is a second source of truth again. Without `ReportBatchItemFailures` one poison
message also fails its whole batch and blocks good updates behind it, which rule
3 explicitly forbids. What a queue would genuinely buy is absorbing a load spike
and decoupling from the venue's network, and if the feed's burst rate ever
approached the table's write limits I would put one in front.

**Powertools' Idempotency utility.** It deduplicates on a payload hash and
returns the cached response, which means a genuine feed duplicate would never
reach `updatesIgnored` at all. The brief requires duplicates to be counted, not
made invisible, so the utility solves a subtly different problem than the one I
have.

**Amplify-style `_version` optimistic locking.** Versions handed out by the store
work when the store is the authority on ordering. Here the revision comes from
the timing system, so the domain's own revision is the lock and a store-assigned
version would just be a second, unrelated number.

**A separate deduplication table.** Another source of truth to keep in step, and
it would swallow exactly the duplicates the brief wants counted.

**`athletesTracked` as a stored counter.** Cheaper to read and impossible to keep
honest. A count cannot drift; a counter can, and under the concurrency that broke
everything else it certainly would have.

**AppSync JavaScript resolvers.** These were my first plan. Everything else here
is TypeScript with tests that run locally in about a second, and APPSYNC_JS
resolvers would have been untyped JavaScript testable only by calling AWS — the
one untested corner of the project. The shaping `eventStats` needs is also four
lines of ordinary code and an awkward response template. The cost of the Lambda I
used instead is one more cold start and one more function competing for this
account's concurrency, which at a race's volumes is not material.

### Settled decisions

Each of these is a decision rather than an oversight, so they are written down.

| Question | Decision | Why |
|---|---|---|
| Rejection at the edge: 400 or 422? | 400 | Either is defensible. What matters is that the count is identical wherever the failure is caught |
| Non-JSON, empty or array body | Corrupt, raw body stored | A corrupt payload may carry no `eventId` at all, which is why `updatesRejected` is pipeline-wide |
| Extra unknown fields | Accepted, then dropped | The brief defines corruption field by field, so an extra field does not make a payload corrupt |
| Whitespace-only `eventId` / `bib` | Corrupt | "Non-empty" read strictly, so `"   "` cannot create an athlete |
| Surrounding whitespace | Trimmed, and the trimmed value is stored | Keeps one row per athlete. A padded bib does read back trimmed |
| `lane` bounds | Any 32-bit integer | The brief requires only "integer", so I did not invent a positivity rule it does not state |
| `timeMs` as `10105.0` | Accepted | Once parsed, JSON cannot distinguish it from `10105` |
| Integer bounds | Rejected above 2^31−1 | GraphQL `Int` is 32-bit, and a larger value would break the read contract on the way out |
| Oversized body | Rejected above 64 KB, before parsing | Parsing costs time in proportion to a body the feed controls |
| Unit tests for the handler | Deliberately none | Mocking the DynamoDB client would test the mock. The deployed harness tests the real thing, and it is what found every real bug |
| SDK retry attempts | Pinned to 1 on the client | The SDK's default of 3 would sit underneath the retry policy in `src/retry.ts`, making that file's stated worst case untrue. One attempt there means one policy, and the budget against the Lambda timeout is real. Transient connection errors now surface as 5xx and the feed re-sends |
| Rejection payload TTL | 30 days, not 7 | The brief asks for the payload to be retrievable afterwards, and the review may be weeks after submission |

---

## 3. AI assistance

I used Claude Code throughout, for the boilerplate.

**What Claude wrote, at my direction:** the CDK stack in `lib/`, the app entry in
`bin/`, the results page, the deployed harness and its fixtures, the stack
assertion and snapshot tests, the snapshot recorder, and the `CLAUDE.md` and
`CONTEXT.md` project notes that ship with this repo.

**What I wrote myself:** everything in `src/` — `validate.ts` and `decide.ts` as
pure functions, `applyValid.ts` with the conditional write, the transaction and
the classification of what a cancellation actually means, `retry.ts`,
`reject.ts`, `db.ts` and the two handlers — plus `schema.graphql`, the unit tests
for the pure functions, the file-header comments, and this document.

**Why there:** the split is between what is being assessed and what is
well-trodden. The three processor rules and the counting are the exercise, and
there is a 35-minute conversation at the end of it picking specific code apart,
so writing that by hand was not optional. The CDK wiring, the page and the
harness are mechanical — a table, a function, an HTTP route, a fetch and a
shuffle — and having them written quickly is what left the time for load testing
against the deployed stack, which is where every real bug turned out to be. I
read every generated line before it was committed, and ran every deployment
myself.

**Where it was wrong, and how I caught it:** my first version of the transaction
declared an expression value it never used, which DynamoDB rejects outright —
every post returned a 500 until it was deployed and tried, and a static
compliance check I ran over the same code passed while it was broken. The three
collision bugs in §2 are mine as well, and were found the same way. On Claude's
side the failures were the ordinary ones: the generated stack targeted a Node
runtime that is already deprecated, and used `logRetention`, which implements
retention by deploying a second Lambda — in an account with a concurrency quota
of 10, that is a function competing with the one doing the work. Both were caught
at `cdk synth`, before anything was deployed.

The one place I would push back on my own choice is the stack tests. They pin the
decisions I care most about — that only the ingest function can write, that the
alarm notifies something, that no function carries a reserved concurrency — and I
did not write them. A test I did not write, that has never failed, is evidence of
nothing at all, which is why I went back and broke the stack on purpose one
change at a time until each one caught what it claims to.

The lesson I would take from this exercise is the one I have already written into
the file headers, and it applies to both halves of that split: verify against the
deployed thing, not against the code as it reads.

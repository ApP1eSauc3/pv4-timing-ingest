# DECISIONS

PV4 timing ingest — RWS Global technical assessment.

Working notes and the register for this document: `docs/CONTEXT.md`.
Fill this in as decisions are made, not at the end.

Time spent: _TBD_

---

## 1. Known concessions

<!-- Anything knowingly left out, shortcut, or believed incomplete or wrong.
     "No known concessions" is a complete answer if it is true.
     Two already known — keep or remove once verified: -->

- A payload rejected by API Gateway itself never reaches the processor and so
  cannot be counted. "Received" means every POST that reaches the Lambda.
- If the Lambda dies between a failed condition and the ignored-counter write, the
  ignored count can be short by one under a crash with no retry.
- **No reserved concurrency on the ingest Lambda.** This account's Lambda
  *Concurrent executions* quota is 10, and AWS only permits a reservation that
  leaves at least 100 unreserved, so the reservation the design called for cannot
  be set. The ingest Lambda therefore competes for concurrency with everything
  else in the account; under a sustained burst some POSTs will be throttled by
  Lambda before reaching the processor and, like an API Gateway rejection, cannot
  be counted. The consequence is not only noisy neighbours: if a grading harness
  posts in parallel and does not retry a 5xx, updates that never reached the
  processor still count as sent, and `accepted + ignored + rejected` will come up
  short of what was sent — a counting failure caused by the quota, not by the
  processor.

<!-- ↑ factual, verified 2026-09-20. Reword in your own voice before submitting. -->

## 2. How it works, and why

<!-- How the implementation satisfies idempotency, ordering and validation;
     why it was built this way; how confident you are, backed by the harness
     numbers rather than adjectives. -->

### Idempotency

### Ordering

### Validation

### Counting

### Settled decisions

These were decided up front rather than discovered late. Each is a decision, not
an oversight.

| Question | Decision | Why |
|---|---|---|
| Rejection at the edge: 400 or 422? | 400 | Either is defensible; what matters is that the count is the same wherever the failure is caught |
| Non-JSON, empty or array body | Corrupt → rejected, raw body stored | A corrupt payload may carry no `eventId` at all, which is why `updatesRejected` is pipeline-wide |
| Extra unknown fields | Accepted, then dropped | They do not make a payload corrupt; the brief defines corruption field by field |
| Whitespace-only `eventId` / `bib` | Corrupt | "Non-empty" read strictly, so `"   "` cannot create a phantom athlete |
| Surrounding whitespace on `eventId` / `bib` | Trimmed, and the trimmed value is what is stored and read back | Keeps one key per athlete. Has a read-side consequence: a padded bib comes back trimmed |
| `lane` bounds | Any 32-bit integer | The brief requires only "integer". Positivity is not a stated rule, so it is not invented here |
| `lane` changing across revisions | Store the latest applied value, log a warning | The brief says lane is fixed but defines no rule for a violation, so it is not grounds for rejection |
| `timeMs` as `10105.0` | Accepted | Once parsed, JSON cannot distinguish it from `10105` |
| Integer bounds | Reject above 2^31−1 | GraphQL `Int` is 32-bit; a larger value would break the read contract the harness runs against |
| Oversized body | Reject above 64 KB *before* `JSON.parse` | Parsing costs time linear in a body the feed controls |
| Test runner | `node:test` via `tsx`, not jest | `cdk init` installed jest; plain `node:test` needs no framework and the tests are pure functions |

### Alternatives considered and discounted

<!-- Only ones genuinely entertained. Candidates listed in docs/CONTEXT.md:
     SQS · Powertools Idempotency · Amplify-style _version locking ·
     a separate dedupe table · athletesTracked as a stored counter. -->

## 3. AI assistance

<!-- What was used, which parts of the solution it was used for, and why there. -->

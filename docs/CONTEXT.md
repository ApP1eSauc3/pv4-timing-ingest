# docs/ — the write-up

Last updated: 2026-09-20

`DECISIONS.md` is read as carefully as the code. It lives at the **repo root**
(the submission asks for it there) — this directory holds working notes and
evidence that feed it.

## Inputs

| Read | For |
|---|---|
| `../DECISIONS.md` | The live document — add to it, don't restart it |
| `../src/CONTEXT.md` | The mechanism being explained |
| `../lib/CONTEXT.md` | Rejected alternatives already identified |

## Process

Write it **as you go**, not at the end. A concession reconstructed at 5 h 30 is
vaguer and less honest than one logged the moment it was made.

**Register.** Plain and specific. Claims backed by measurements, not adjectives.
"No known concessions" is a complete answer if it is true; a list of real ones is
better than a claim of completeness that does not survive the interview.

**The three required sections:**

1. **Known concessions** — anything knowingly left out, shortcut, or believed
   incomplete. Already known to belong here:
   - A payload API Gateway itself rejects never reaches the Lambda and so cannot be
     counted. "Received" means every POST that reaches the processor.
   - If the Lambda dies between a failed condition and the ignored-counter write,
     the ignored count can be short by one under a crash with no retry.
2. **How it works, and why** — how the implementation satisfies the three rules,
   why it was built that way, and how confident you are. Alternatives considered
   and discounted, **only ones genuinely entertained**:
   - **SQS** — the conditional write already gives idempotency, so a queue adds no
     correctness. It adds a redelivery path that would double-count ignored, and
     without `ReportBatchItemFailures` one poison message blocks the good updates
     behind it, which rule 3 forbids. Say what it *would* buy (absorbing spikes,
     decoupling from the venue) and when you'd switch.
   - **Powertools Idempotency** — dedupes on payload hash, so feed duplicates would
     never reach `updatesIgnored`.
   - **Amplify-style `_version` optimistic locking** — versions come from the
     store; here `revision` comes from the timing system, so the domain revision is
     the lock.
   - **A separate dedupe table** — a second source of truth that would swallow
     duplicates which must still be counted.
   - **`athletesTracked` as a stored counter** — a count cannot drift, a counter can.
3. **AI assistance** — what was used, on which parts, and why there. Be specific.

**Settle these early and write each one down** — each is a decision, not an oversight:

| Question | Decision |
|---|---|
| Rejection at the edge: 400 or 422? | 400. Either is allowed; counts must match either way |
| Non-JSON, empty or array body | Corrupt → rejected, raw body stored |
| Extra unknown fields | Accepted and ignored — they don't make a payload corrupt |
| `lane` changing across revisions | Store latest applied, log a warning. The brief states no rule for it |
| `timeMs` as `10105.0` | Indistinguishable from `10105` once parsed. Accepted |
| Integer bounds | Reject above 2^31−1 — GraphQL `Int` is 32-bit and larger breaks the read contract |
| Oversized body | Reject above 64 KB *before* `JSON.parse`; stored `rawBody` truncated with a `truncated: true` flag |

**Write by hand, no assistance:** the whole processor — validation, the ordering
rule, the condition expression, the transaction and its outcome classification,
the retry policy and the rejection path — plus `schema.graphql`, the unit tests
for the pure functions, the file-header comments and all of `DECISIONS.md`.
There is a 35-minute conversation picking specific code apart — anything you
cannot explain should not be submitted.

**Assistance is for:** the CDK stack, the results page, the deployed harness and
its fixtures, the stack assertion and snapshot tests, and these project notes.
Read every generated line before it is committed.

**Before the repo goes public:** run the `launch-security` skill. The AppSync API
key is meant to be shared. Nothing else is — no account id, no credentials, no
private notes. This directory and every `CONTEXT.md` ship publicly too.

## Outputs

- `../DECISIONS.md` — the deliverable, at repo root.
- `../README.md` — deploy steps and the four deployed URLs.
- Harness output pasted into `DECISIONS.md` as evidence: counters **and** final
  state, including the concurrency case (revisions 1–6 for one bib fired at once,
  ×20, final state always revision 6).

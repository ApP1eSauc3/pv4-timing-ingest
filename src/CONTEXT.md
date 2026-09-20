# src/ — the processor

Last updated: 2026-09-21

This is the part that is actually being marked. Everything here serves three rules:
a duplicate applies once, a lower revision never overwrites a higher one, and a
corrupt payload is rejected without crashing the processor or blocking the updates
behind it.

## Inputs

| Read | For |
|---|---|
| `../CLAUDE.md` | Counting invariant, naming, ordering rule |
| `../DECISIONS.md` | Decisions already settled — do not re-litigate, add to it |
| `../lib/CONTEXT.md` | Table layout, the exact GraphQL contract the counters feed |

## Process

Split into pure modules first, wire them to AWS second. `validate(raw)` and
`decide(stored, incoming)` are pure functions with no SDK imports — they are the
two things worth unit testing and the two things to be able to explain line by line.

**Table layout** (single table, on-demand, TTL on `expiresAt`):

| PK | SK | Holds |
|---|---|---|
| `EVENT#<eventId>` | `BIB#<bib>` | bib, lane, revision, status, timeMs, recordedAt, updatedAt |
| `EVENT#<eventId>` | `STATS#<0-24>` | updatesAccepted, updatesIgnored |
| `EVENTS` | `<eventId>` | firstSeenAt |
| `GLOBAL` | `STATS#<0-24>` | updatesRejected |
| `REJECTED` | `<receivedAt>#<uuid>` | rawBody (truncated), truncated, bodyMissing, failedChecks, requestId, receivedAt, expiresAt |

Stats and every bib share a partition key on purpose: one Query returns every
counter row and every athlete together, so `athletesTracked` is **derived by
counting `BIB#` items**, never stored as a counter. A counter is a second source
of truth that can drift; a count cannot.

**Counters are spread over `STATS_SHARDS = 25` rows** (`db.ts:68`), written to a
random shard and summed on read (`shapeStats.ts:26-30`). This came from load
testing, not from the plan: a single row meant every update for an event collided
with every other, including updates for unrelated athletes. The read still costs
one Query because the shards share the partition. A plain `STATS` item with no
suffix is matched too, so events written before sharding still read correctly.

**Ordering and idempotency are the same conditional write:**

```
ConditionExpression: attribute_not_exists(revision) OR revision < :rev
```

Write succeeds → accepted. Condition fails → ignored. It never reads `status`, so
revision 4 `PROVISIONAL` correctly overwrites revision 3 `OFFICIAL` when a jury
reopens a result. A duplicate has `revision == stored`, so the condition fails and
it is counted as ignored rather than silently swallowed.

**The load-bearing branch.** `TransactWriteItems` raises one
`TransactionCanceledException` for two very different situations. Read
`CancellationReasons[i].Code`:

| Code | Means | Do |
|---|---|---|
| `ConditionalCheckFailed` | Revision was not greater — duplicate or stale | Count **ignored**, return 200 |
| `TransactionConflict` | Two writers touched the item at once. Says **nothing** about revision | **Retry**, jittered backoff, then 5xx |
| `ThrottlingError`, `ProvisionedThroughputExceeded` | Capacity | Retry, then 5xx |

**The retry budget** (`retry.ts:15-29`): `MAX_ATTEMPTS = 8`, 25 ms base, doubling,
capped at 200 ms, plus jitter — about 1.2 s worst case against the Lambda's 10 s
timeout. Uncapped doubling would reach 3.2 s on the last attempt alone and risk a
timeout, which returns 5xx with no classification running at all. The jitter is
not decoration: without it two colliding writers retry in lockstep and collide
again.

Get this wrong and you cause exactly the failure the brief cares about: revision 4
loses a conflict, is misread as "ignored", and the result sticks at revision 3
permanently — a jury reopening that never reaches the scoreboard. The SDK does not
retry cancellations for you.

```
// ✅ classify before counting
if (reason === 'ConditionalCheckFailed') return ignored();
if (reason === 'TransactionConflict')    return retry();

// ❌ every cancellation treated as a stale revision — loses jury reopenings
catch (e) { if (e.name === 'TransactionCanceledException') return ignored(); }
```

**Other traps already paid for:**

```
// ✅ events registry — tolerates every update after the first
Update … SET firstSeenAt = if_not_exists(firstSeenAt, :now)

// ❌ conditional Put — fails the whole transaction on update 2+, counted as
//    "ignored" silently, and a single-update test still passes
Put … ConditionExpression: attribute_not_exists(PK)
```

- Do **not** use Powertools' Idempotency utility. It dedupes on a payload hash and
  returns a cached response, so a feed duplicate would never reach `updatesIgnored`.
  The conditional write already makes this idempotent. Say why in `DECISIONS.md`.
- Validate strictly — accept only what is positively valid. `Number.isInteger(x)`,
  `typeof x === 'string' && x.length > 0`, exact `status` set. `"3"`, `3.5`,
  `"official"` and `null` are all corrupt. Do not validate or order on `recordedAt`.
- Check body size, then parse, then validate — all before any write, so a corrupt
  payload can never create a phantom athlete.
- Structure validation as **named checks** (`eventId_nonEmpty`, `revision_gte1`, …)
  so the failing names go into the log and the stored rejection record, and a
  rejection explains itself.
- Never ignore a write error. Anything that is not `ConditionalCheckFailed` throws.
  A failed write must never be counted as "ignored".

## Outputs

- `validate.ts`, `decide.ts` — pure, no SDK imports.
- `handler.ts` — the ingest Lambda: decode → size check → parse → validate →
  transaction → classify → count. The decode step is not optional: API Gateway
  base64-encodes anything it treats as binary, and validating the encoded string
  would reject those as corrupt.
- Tests in `../test/`, using the brief's six-row worked example as a literal fixture
  (three accepted, three ignored, final state revision 4 `PROVISIONAL`), every
  corrupt-field variant, and a shuffled-permutation test asserting final state is
  always max revision.

**Resolved 2026-09-20 — `node:test`, not jest.** `CLAUDE.md` already specified
node:test, so this was never genuinely open. `jest`, `@swc/jest`, `@types/jest` and
`jest.config.js` are removed; `tsx` was already a devDependency, so the runner is
`node --import tsx --test test/*.test.ts` (`npm test`).

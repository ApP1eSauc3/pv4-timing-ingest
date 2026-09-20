# PV4 timing ingest — RWS Global technical assessment

Last updated: 2026-09-21

Ingest-and-read pipeline in AWS CDK (TypeScript):
`POST /timing` → processor → DynamoDB → AppSync (API key) → CloudFront + S3 page.

Three things are graded: the **three processor rules** (idempotency, ordering,
validation), **exact counting**, and **`DECISIONS.md`**. Timebox 4–6 h — a
well-reasoned partial submission beats a complete one that cost a weekend.

## Structure

```
bin/ lib/   CDK app entry + stack constructs
src/        processor — validation, ordering decision, DynamoDB writes
test/       node:test unit tests + the deployed-stack harness
web/        index.html results page (deployed by BucketDeployment)
docs/       write-up working notes → DECISIONS.md at repo root
```

## Routing

| Task | Go to | Read | Skills |
|---|---|---|---|
| CDK construct, AWS wiring, teardown | `lib/` | `lib/CONTEXT.md` | — |
| Validation, ordering, counters, writes | `src/` | `src/CONTEXT.md` | — |
| Unit test or harness run | `test/` | `src/CONTEXT.md` | — |
| Results page | `web/` | `lib/CONTEXT.md` | — |
| Write-up, or logging a concession | `DECISIONS.md` | `docs/CONTEXT.md` | — |
| Before making the repo public | — | `docs/CONTEXT.md` | `launch-security` |

## Naming

- Stack `Pv4TimingStack`; every resource prefixed `pv4-`; stack tagged `project=pv4`.
- Source files camelCase (`queryHandler.ts`, `applyValid.ts`); types PascalCase,
  no `I` prefix.
- Tests live in `test/` as `<subject>.test.ts`, mirroring `src/`. The stack tests
  are named for what they assert instead: `stack-assertions`, `stack-snapshot`.

## Non-negotiable

- **`revision` is the only ordering signal**, per `bib`. `status` is data to store,
  never something to order by. A higher revision wins whatever status it carries.
- **Every update lands in exactly one** of `updatesAccepted`, `updatesIgnored`,
  `updatesRejected`. Assert `accepted + ignored + rejected == sent`, and assert
  final state per bib separately — balanced is not the same as correct.
- **Never run a bare `cdk destroy`** — always `cdk destroy Pv4TimingStack`. This
  account runs other production workloads. Never delete `CDKToolkit`.
- Nothing secret in this repo. The AppSync API key is meant to be shared; the
  account id, credentials and private notes are not. This repo goes public.

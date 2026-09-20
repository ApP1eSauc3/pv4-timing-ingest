# PV4 timing ingest

Ingest-and-read pipeline for live competition timing updates, defined in AWS CDK
(TypeScript).

```
POST /timing  ──▶  processor  ──▶  DynamoDB  ──▶  AppSync (GraphQL)  ──▶  CloudFront page
```

See [`DECISIONS.md`](./DECISIONS.md) for the design rationale and known concessions.

## Deployed endpoints

| | |
|---|---|
| Ingest URL | _TBD_ |
| AppSync GraphQL URL | _TBD_ |
| AppSync API key | _TBD_ |
| CloudFront URL | _TBD_ |

## Deploy

```bash
npm install
npx cdk bootstrap          # once per account + region
npx cdk deploy Pv4TimingStack
```

The four URLs above are emitted as stack outputs.

## Test

```bash
npm test                   # node:test — validation and ordering decision
```

## Teardown

```bash
npx cdk destroy Pv4TimingStack
```

Never run a bare `cdk destroy`, and do not delete the shared `CDKToolkit` stack.

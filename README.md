# PV4 timing ingest

Ingest-and-read pipeline for live competition timing updates, defined in AWS CDK
(TypeScript).

```
POST /timing  ──▶  processor  ──▶  DynamoDB  ──▶  AppSync (GraphQL)  ──▶  CloudFront page
```

The timing feed delivers at-least-once, out of order, and occasionally corrupt.
The processor stays correct anyway: a duplicate applies once, a lower revision
never overwrites a higher one, and a corrupt payload is rejected and counted
without blocking anything behind it.

See [`DECISIONS.md`](./DECISIONS.md) for the design, the concessions and the
measured evidence behind them.

## Deployed endpoints

| | |
|---|---|
| Ingest URL | `https://97uk7xkh26.execute-api.ap-southeast-2.amazonaws.com/timing` |
| AppSync GraphQL URL | `https://v4tz5wuyl5gqvb5pl6msz7r6iq.appsync-api.ap-southeast-2.amazonaws.com/graphql` |
| AppSync API key | `da2-jhxc54srifcidc7kjtkiocak5m` |
| Results page | `https://d264dekl0xqfqc.cloudfront.net` |

The API key is read-only and is meant to be shared. It expires 365 days after
deployment.

## Try it

```bash
export INGEST_URL="https://97uk7xkh26.execute-api.ap-southeast-2.amazonaws.com/timing"
export GQL_URL="https://v4tz5wuyl5gqvb5pl6msz7r6iq.appsync-api.ap-southeast-2.amazonaws.com/graphql"
export GQL_KEY="da2-jhxc54srifcidc7kjtkiocak5m"

# A well-formed update
curl -s -X POST "$INGEST_URL" -H 'content-type: application/json' \
  -d '{"eventId":"WC26-ATH-M100M-SF2","bib":"AUS-1147","lane":3,"revision":1,
       "status":"PROVISIONAL","timeMs":10105,"recordedAt":"2026-08-25T19:42:07.000Z"}'
# {"outcome":"ACCEPTED"}

# The same update again — applied once, counted as ignored
# A lower revision — ignored. A higher one — accepted, whatever status it carries.

# A corrupt payload
curl -s -X POST "$INGEST_URL" -d 'not json'
# {"outcome":"REJECTED","failedChecks":["body_isJson"]}

# Read it back
curl -s -H "x-api-key: $GQL_KEY" -H 'content-type: application/json' \
  -d '{"query":"{ events results(eventId:\"WC26-ATH-M100M-SF2\"){ bib lane revision status timeMs } eventStats(eventId:\"WC26-ATH-M100M-SF2\"){ athletesTracked updatesAccepted updatesIgnored } updatesRejected }"}' \
  "$GQL_URL"
```

## Layout

```
bin/    CDK app entry
lib/    the stack, and the GraphQL schema
src/    the processor — validation, ordering, writes, and the read API
test/   unit tests, stack tests, and the deployed-stack harness
web/    the results page
```

## Deploy

```bash
npm install
npx cdk bootstrap            # once per account + region
npx cdk deploy Pv4TimingStack
```

The four URLs above are printed as stack outputs.

The CloudWatch alarm publishes to an SNS topic with no subscription of its own,
because an email address does not belong in a public repo. To receive alarms:

```bash
aws sns subscribe --topic-arn <the pv4-alarms topic ARN> \
  --protocol email --notification-endpoint <your address> --region ap-southeast-2
```

## Test

```bash
npm test        # unit tests, stack assertions and the template snapshot
npm run snapshot   # re-record the stack snapshot after an intended change
```

The harness runs against a **deployed** stack rather than a mock, because every
real bug in this project was found there and not locally:

```bash
INGEST_URL=... GQL_URL=... GQL_KEY=... npm run harness
```

It sends 200 shuffled updates across 8 athletes with duplicates and corrupt
payloads mixed in, then fires six revisions at one athlete simultaneously,
twenty times over. It asserts both that the counters balance and that every
athlete ended at their highest revision — balanced is not the same as correct.

## Teardown

```bash
npx cdk destroy Pv4TimingStack
```

Always name the stack. Never run a bare `cdk destroy`, and do not delete the
shared `CDKToolkit` stack.

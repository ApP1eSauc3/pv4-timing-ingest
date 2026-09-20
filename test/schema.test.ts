import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The brief's contract is run against by an automated harness, so these lines
 * must survive any future edit to the schema. Additions alongside them are fine.
 */
const schema = readFileSync(join(__dirname, '..', 'lib', 'schema.graphql'), 'utf8');

const required = [
  'enum ResultStatus { PROVISIONAL CONFIRMED OFFICIAL }',
  'bib:      ID!',
  'lane:     Int!',
  'revision: Int!',
  'status:   ResultStatus!',
  'timeMs:   Int!',
  'eventId:         ID!',
  'athletesTracked: Int!',
  'updatesAccepted: Int!',
  'updatesIgnored:  Int!',
  'events:                   [ID!]!',
  'results(eventId: ID!):    [Result!]!',
  'eventStats(eventId: ID!): EventStats!',
  'updatesRejected:          Int!',
];

for (const line of required) {
  test(`schema still declares: ${line.trim()}`, () => {
    assert.ok(schema.includes(line), `missing from lib/schema.graphql: ${line}`);
  });
}

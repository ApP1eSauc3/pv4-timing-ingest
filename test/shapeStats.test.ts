import test from 'node:test';
import assert from 'node:assert/strict';

import { shapeEventStats } from '../src/shapeStats';

const bib = (n: string) => ({ SK: `BIB#${n}`, bib: n, revision: 1 });

test('an event nobody has posted to returns zeros, not null', () => {
  assert.deepEqual(shapeEventStats('UNKNOWN', []), {
    eventId: 'UNKNOWN',
    athletesTracked: 0,
    updatesAccepted: 0,
    updatesIgnored: 0,
  });
});

test('athletes are counted, and the stats item is not one of them', () => {
  const items = [
    { SK: 'STATS', updatesAccepted: 7, updatesIgnored: 3 },
    bib('AUS-1147'),
    bib('GBR-2201'),
    bib('JAM-0093'),
  ];

  assert.deepEqual(shapeEventStats('WC26-ATH-M100M-SF2', items), {
    eventId: 'WC26-ATH-M100M-SF2',
    athletesTracked: 3,
    updatesAccepted: 7,
    updatesIgnored: 3,
  });
});

test('counters without athletes', () => {
  const shaped = shapeEventStats('E', [{ SK: 'STATS', updatesAccepted: 2, updatesIgnored: 1 }]);
  assert.equal(shaped.athletesTracked, 0);
  assert.equal(shaped.updatesAccepted, 2);
});

test('athletes without counters still report the athletes', () => {
  // This is the state mid-implementation if the counters have not landed yet.
  // The read side must stay sane rather than throw or report null.
  const shaped = shapeEventStats('E', [bib('AUS-1147'), bib('GBR-2201')]);
  assert.equal(shaped.athletesTracked, 2);
  assert.equal(shaped.updatesAccepted, 0);
  assert.equal(shaped.updatesIgnored, 0);
});

test('athletesTracked is a count, so it cannot drift from the athletes present', () => {
  // A stored counter could say 9 while three athletes exist. A count cannot.
  const items = [{ SK: 'STATS', updatesAccepted: 99, updatesIgnored: 99 }, bib('A'), bib('B')];
  assert.equal(shapeEventStats('E', items).athletesTracked, 2);
});

test('counter shards are summed, not read from one item', () => {
  const items = [
    { SK: 'STATS#0', updatesAccepted: 4, updatesIgnored: 1 },
    { SK: 'STATS#3', updatesAccepted: 2, updatesIgnored: 5 },
    { SK: 'STATS#7', updatesAccepted: 1, updatesIgnored: 0 },
    bib('AUS-1147'),
  ];
  const shaped = shapeEventStats('E', items);
  assert.equal(shaped.updatesAccepted, 7);
  assert.equal(shaped.updatesIgnored, 6);
  assert.equal(shaped.athletesTracked, 1, 'shards must not be counted as athletes');
});

test('events written before sharding still read correctly', () => {
  // The worked example on the deployed stack has an unsharded `STATS` item.
  // Matching only `STATS#` would silently report zeros for it.
  const shaped = shapeEventStats('E', [{ SK: 'STATS', updatesAccepted: 3, updatesIgnored: 3 }, bib('A')]);
  assert.equal(shaped.updatesAccepted, 3);
  assert.equal(shaped.updatesIgnored, 3);
});

test('a mix of old and new counter items sums both', () => {
  const shaped = shapeEventStats('E', [
    { SK: 'STATS', updatesAccepted: 3, updatesIgnored: 3 },
    { SK: 'STATS#2', updatesAccepted: 1, updatesIgnored: 0 },
  ]);
  assert.equal(shaped.updatesAccepted, 4);
  assert.equal(shaped.updatesIgnored, 3);
});

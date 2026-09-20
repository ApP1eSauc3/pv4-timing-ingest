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

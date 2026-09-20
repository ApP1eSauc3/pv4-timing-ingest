/**
 * Ordering and idempotency, which turn out to be the same rule.
 *
 * This is that rule written twice, on purpose. DynamoDB enforces it with a
 * condition on the write:
 *
 *   attribute_not_exists(revision) OR revision < :rev
 *
 * and this function says the same thing in plain code. Both earn their place.
 * Only the database can settle things when two Lambdas write the same athlete at
 * the same instant, and only a pure function can be tested against every
 * possible arrival order, which is what the tests do.
 *
 * The rule itself: a higher revision always wins. Status has nothing to do with
 * it, which is why it is not a parameter here and should never become one. That
 * is precisely what lets a jury reopen a result - revision 4 PROVISIONAL beats
 * revision 3 OFFICIAL and the scoreboard goes back to provisional, which is what
 * the stadium needs to see.
 */

export type Decision = 'APPLY' | 'IGNORE';

export function decide(storedRevision: number | undefined, incomingRevision: number): Decision {
  // Never seen this athlete before, so there is nothing to compare against yet.
  if (storedRevision === undefined) return 'APPLY';

  // Strictly greater, nothing else. Equal means a duplicate turned up, lower
  // means an old update arrived late, and neither is new information - so the
  // same comparison handles both without needing a separate case for either.
  return incomingRevision > storedRevision ? 'APPLY' : 'IGNORE';
}

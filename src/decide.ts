/**
 * Ordering and idempotency, which are the same rule.
 *
 * The rule written twice, on purpose. DynamoDB enforces it on the write:
 *
 *   attribute_not_exists(revision) OR revision < :rev
 *
 * This function says the same thing in plain code. Both earn their place: only
 * the database can settle two Lambdas writing the same athlete at once, and only
 * a pure function can be tested against every arrival order.
 *
 * The rule: a higher revision always wins. Status has nothing to do with it and
 * is not a parameter here. That is what lets a jury reopen a result - revision 4
 * PROVISIONAL beats revision 3 OFFICIAL.
 */

export type Decision = 'APPLY' | 'IGNORE';

export function decide(storedRevision: number | undefined, incomingRevision: number): Decision {
  // Never seen this athlete before, so there is nothing to compare against yet.
  if (storedRevision === undefined) return 'APPLY';

  // Strictly greater. Equal is a duplicate, lower is a late arrival, and
  // neither is new information - one comparison handles both.
  return incomingRevision > storedRevision ? 'APPLY' : 'IGNORE';
}

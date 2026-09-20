/**
 * Ordering and idempotency — the first two processor rules.
 *
 * This is the same rule written twice. DynamoDB enforces it with a condition on
 * the write:
 *
 *   attribute_not_exists(revision) OR revision < :rev
 *
 * and this function says the same thing in plain code. Both are needed. Only the
 * database can settle it when two Lambdas write the same bib at the same instant.
 * Only a pure function can be tested against every possible arrival order.
 *
 * The rule is: a higher revision always wins. Status has nothing to do with it,
 * which is why status is not a parameter here and must not become one. That is
 * exactly what lets a jury reopen a result — revision 4 PROVISIONAL beats
 * revision 3 OFFICIAL, and the scoreboard goes back to provisional as it should.
 */

export type Decision = 'APPLY' | 'IGNORE';

export function decide(storedRevision: number | undefined, incomingRevision: number): Decision {
  // Never seen this bib before, so there is nothing to compare against. Store it.
  if (storedRevision === undefined) return 'APPLY';

  // Strictly greater, nothing else. Equal means a duplicate arrived; lower means
  // an old update turned up late. Neither is new information, so both are dropped.
  return incomingRevision > storedRevision ? 'APPLY' : 'IGNORE';
}

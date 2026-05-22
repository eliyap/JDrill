// Pure logic the drill stack relies on. Nothing here touches the DOM,
// network, or sql.js — so it's unit-testable in plain Node.
//
// The functions here are the "is this state reasonable?" predicates and
// helpers. The UI layer (main.js) consumes them in render and side-effects.
// Putting them here makes the queue invariant testable independent of the
// React reconciler's dependency tracking, which is what broke the prefill
// loop in commit e6daa5b.

/**
 * Count of cards still in the active set (awaiting input or judgment).
 * Graded cards are records, not slots.
 */
export function freshOrGradingCount(cards) {
  let n = 0;
  for (const c of cards) {
    if (c.state === "fresh" || c.state === "grading") n++;
  }
  return n;
}

/**
 * Decide whether the prefetch loop should kick off another generation.
 *
 * Inputs come from the React tree at the moment of decision; output is a
 * pure boolean so the call site doesn't have to reason about React's
 * dependency-tracking semantics.
 *
 *   { cards, inflight, autoGenerate, queueTarget, hasKey }
 *
 * Note: `cards` is the full list (including graded ones). We deliberately
 * count only fresh+grading toward the target so that graded cards left in
 * the stack as study record don't block further generation.
 */
export function shouldRefill({ cards, inflight, autoGenerate, queueTarget, hasKey }) {
  if (!hasKey) return false;
  if (!autoGenerate) return false;
  const target = Math.max(1, queueTarget | 0);
  return freshOrGradingCount(cards) + (inflight | 0) < target;
}

/**
 * Pick k random distinct elements from arr. Used to seed the candidate set
 * shown to the model per generation call.
 *
 * Returns at most arr.length items (silently clamps if k > arr.length).
 * Order within the returned array is the order items were drawn — not
 * the order they appeared in the input.
 */
export function sample(arr, k) {
  const n = Math.min(k | 0, arr.length);
  if (n <= 0) return [];
  const picked = new Set();
  const out = [];
  while (out.length < n) {
    const i = Math.floor(Math.random() * arr.length);
    if (picked.has(i)) continue;
    picked.add(i);
    out.push(arr[i]);
  }
  return out;
}

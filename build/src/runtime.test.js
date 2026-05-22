// Pure-logic tests. Run with `npm test` (which is `node --test`).
//
// These exist so refactors of the queue-maintenance logic can't silently
// regress the prefill loop — which is exactly what shipped in commit
// e6daa5b and forced commit e4bea21 to fix.

import { test } from "node:test";
import assert from "node:assert/strict";

import { shouldRefill, freshOrGradingCount, sample } from "./runtime.js";

const BASE = { cards: [], inflight: 0, autoGenerate: true, queueTarget: 3, hasKey: true };

test("freshOrGradingCount: ignores graded cards", () => {
  const cards = [
    { state: "fresh" }, { state: "grading" },
    { state: "graded-pass" }, { state: "graded-fail" },
  ];
  assert.equal(freshOrGradingCount(cards), 2);
});

test("freshOrGradingCount: empty list → 0", () => {
  assert.equal(freshOrGradingCount([]), 0);
});

test("shouldRefill: no API key → false", () => {
  assert.equal(shouldRefill({ ...BASE, hasKey: false }), false);
});

test("shouldRefill: auto-gen off → false", () => {
  assert.equal(shouldRefill({ ...BASE, autoGenerate: false }), false);
});

test("shouldRefill: empty queue under target → true", () => {
  assert.equal(shouldRefill({ ...BASE, queueTarget: 3 }), true);
});

test("shouldRefill: at target via fresh+grading+inflight → false", () => {
  const cards = [{ state: "fresh" }, { state: "grading" }];
  assert.equal(
    shouldRefill({ ...BASE, cards, inflight: 1, queueTarget: 3 }),
    false,
  );
});

test("shouldRefill: only graded cards in stack → true", () => {
  // The regression that lived behind the prefill bug: graded cards count
  // for nothing toward queue_target. If they did, the user would never
  // get more drills after answering a few.
  const cards = [
    { state: "graded-pass" }, { state: "graded-fail" }, { state: "graded-pass" },
  ];
  assert.equal(
    shouldRefill({ ...BASE, cards, queueTarget: 3 }),
    true,
    "graded cards should not block further generation",
  );
});

test("shouldRefill: grading → graded transition opens a slot", () => {
  // The exact bug fixed in e4bea21. Before grading completes, the
  // grading card holds a slot. After, it's a study record and the loop
  // should kick off a replacement.
  const before = [{ state: "fresh" }, { state: "fresh" }, { state: "grading" }];
  const after  = [{ state: "fresh" }, { state: "fresh" }, { state: "graded-fail" }];
  assert.equal(shouldRefill({ ...BASE, cards: before, queueTarget: 3 }), false,
    "no refill needed while grading is in flight");
  assert.equal(shouldRefill({ ...BASE, cards: after, queueTarget: 3 }), true,
    "refill must trigger when grading completes");
});

test("shouldRefill: queueTarget=1 minimum", () => {
  // Settings input is sanitized client-side but defend against 0 / NaN.
  assert.equal(shouldRefill({ ...BASE, queueTarget: 0 }), true);
  assert.equal(shouldRefill({ ...BASE, queueTarget: NaN }), true);
});

test("sample: returns at most arr.length items", () => {
  assert.equal(sample([1, 2, 3], 10).length, 3);
});

test("sample: returns exactly k items when k ≤ length", () => {
  assert.equal(sample([1, 2, 3, 4, 5], 3).length, 3);
});

test("sample: distinct picks (no duplicates)", () => {
  const arr = Array.from({ length: 50 }, (_, i) => i);
  const picked = sample(arr, 20);
  assert.equal(new Set(picked).size, 20);
});

test("sample: k=0 → empty", () => {
  assert.deepEqual(sample([1, 2, 3], 0), []);
});

test("sample: empty input → empty", () => {
  assert.deepEqual(sample([], 5), []);
});

// Pure-logic tests. Run with `npm test` (which is `node --test`).
//
// These exist so refactors of the queue-maintenance logic can't silently
// regress the prefill loop — which is exactly what shipped in commit
// e6daa5b and forced commit e4bea21 to fix.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  shouldRefill, freshOrGradingCount, sample,
  buildRubyAnnotator, renderRuby, cardsReducer,
} from "./runtime.js";

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

// -- ruby annotation -----------------------------------------------------------

test("buildRubyAnnotator: ignores vocab without a ruby field", () => {
  const { map, keys } = buildRubyAnnotator([
    { jp: "たべる", en: "to eat" },                                       // no ruby
    { jp: "食べ物", en: "food", ruby: [["食","た"],["べ",null],["物","もの"]] },
  ]);
  assert.equal(map.size, 1);
  assert.deepEqual(keys, ["食べ物"]);
});

test("buildRubyAnnotator: keys sorted longest-first", () => {
  const { keys } = buildRubyAnnotator([
    { jp: "日", ruby: [["日","ひ"]] },
    { jp: "日本", ruby: [["日","に"],["本","ほん"]] },
    { jp: "日本語", ruby: [["日","に"],["本","ほん"],["語","ご"]] },
  ]);
  assert.deepEqual(keys, ["日本語", "日本", "日"]);
});

test("renderRuby: empty text → empty list", () => {
  assert.deepEqual(renderRuby("", new Map(), []), []);
});

test("renderRuby: no vocab matches → single plain segment", () => {
  const out = renderRuby("こんにちは世界", new Map(), []);
  assert.deepEqual(out, [{ kind: "plain", text: "こんにちは世界" }]);
});

test("renderRuby: single word with annotations", () => {
  const { map, keys } = buildRubyAnnotator([
    { jp: "食べ物", ruby: [["食","た"],["べ",null],["物","もの"]] },
  ]);
  const out = renderRuby("食べ物が好き", map, keys);
  assert.equal(out.length, 2);
  assert.equal(out[0].kind, "ruby");
  assert.deepEqual(out[0].segments, [["食","た"],["べ",null],["物","もの"]]);
  assert.deepEqual(out[1], { kind: "plain", text: "が好き" });
});

test("renderRuby: longest match wins", () => {
  // The canonical case: `日本` vs `日`. Without longest-first ordering,
  // `日` would match first and `本` would be left plain. We want the
  // word-level reading 「にほん」 for 「日本」.
  const { map, keys } = buildRubyAnnotator([
    { jp: "日",   ruby: [["日","ひ"]] },
    { jp: "日本", ruby: [["日","に"],["本","ほん"]] },
  ]);
  const out = renderRuby("日本へ行く", map, keys);
  assert.equal(out[0].kind, "ruby");
  assert.deepEqual(out[0].segments, [["日","に"],["本","ほん"]]);
  assert.equal(out[1].kind, "plain");
  assert.equal(out[1].text, "へ行く");
});

test("renderRuby: multiple matches in sequence", () => {
  const { map, keys } = buildRubyAnnotator([
    { jp: "食べ物", ruby: [["食","た"],["べ",null],["物","もの"]] },
    { jp: "美味",   ruby: [["美","び"],["味","み"]] },
  ]);
  const out = renderRuby("美味な食べ物です。", map, keys);
  assert.equal(out.length, 4);
  assert.equal(out[0].kind, "ruby");
  assert.equal(out[1].kind, "plain"); assert.equal(out[1].text, "な");
  assert.equal(out[2].kind, "ruby");
  assert.equal(out[3].kind, "plain"); assert.equal(out[3].text, "です。");
});

test("renderRuby: rejects match when preceding char is kanji (compound)", () => {
  // The 高円寺 case. Vocab has 寺 → てら. In the place-name compound 高円寺
  // the 寺 reads じ, not てら, so applying てら here is wrong. The boundary
  // check must refuse this annotation.
  const { map, keys } = buildRubyAnnotator([
    { jp: "寺", ruby: [["寺","てら"]] },
  ]);
  const out = renderRuby("高円寺の方が", map, keys);
  assert.ok(out.every(t => t.kind === "plain"),
    "no ruby annotations should be emitted when 寺 sits between kanji");
});

test("renderRuby: rejects partial match into a longer kanji compound", () => {
  // 日本 in vocab, text says 日本人 — annotating just 日本 would imply a
  // word boundary that isn't there. Reject and leave plain.
  const { map, keys } = buildRubyAnnotator([
    { jp: "日本", ruby: [["日","に"],["本","ほん"]] },
  ]);
  const out = renderRuby("日本人です。", map, keys);
  assert.deepEqual(out, [{ kind: "plain", text: "日本人です。" }]);
});

test("renderRuby: still annotates when kanji bounded by non-kanji", () => {
  // Same vocab entry as the rejection test above — must work in legitimate
  // contexts. お寺 has hiragana on the left, へ on the right.
  const { map, keys } = buildRubyAnnotator([
    { jp: "寺", ruby: [["寺","てら"]] },
  ]);
  const out = renderRuby("お寺へ行く", map, keys);
  const rubyTokens = out.filter(t => t.kind === "ruby");
  assert.equal(rubyTokens.length, 1, "should annotate 寺 when bounded by kana");
  assert.deepEqual(rubyTokens[0].segments, [["寺","てら"]]);
});

test("renderRuby: regression — the 高円寺 failure verbatim", () => {
  // The actual sentence the user pasted in chat. Three vocab entries
  // matched: 寺 (single-char, wrong inside the compound), 通り, 静か.
  // After the boundary fix: 寺 is rejected; 通り and 静か are still
  // annotated because they're bounded by hiragana on both sides.
  const { map, keys } = buildRubyAnnotator([
    { jp: "寺",   ruby: [["寺","てら"]] },
    { jp: "通り", ruby: [["通","とお"],["り",null]] },
    { jp: "静か", ruby: [["静","しず"],["か",null]] },
  ]);
  const out = renderRuby("高円寺の方がこの通りより静かです。", map, keys);
  const rubyTokens = out.filter(t => t.kind === "ruby");
  assert.equal(rubyTokens.length, 2, "exactly two annotations: 通り and 静か");
  const rubied = rubyTokens.map(t => t.segments[0][0]);
  assert.ok(!rubied.includes("寺"), "寺 inside 高円寺 must NOT be annotated");
  assert.ok(rubied.includes("通"), "通り should still annotate");
  assert.ok(rubied.includes("静"), "静か should still annotate");
});

// -- Reducer + queue cycle ----------------------------------------------------
//
// These exercise the bit the predicate tests cannot: the full
// "dispatch action → cards changes → shouldRefill flips → kickOff fires"
// loop. The previous test suite only covered the predicate, so a wiring bug
// in skipCard or in the reducer would have passed CI silently.

test("cardsReducer: add appends, returns new array", () => {
  const s0 = [];
  const s1 = cardsReducer(s0, { type: "add", card: { id: "a", state: "fresh" } });
  assert.notEqual(s1, s0, "must produce a new array (useEffect dep tracking)");
  assert.equal(s1.length, 1);
  assert.equal(s1[0].id, "a");
});

test("cardsReducer: remove drops the matching card", () => {
  const s0 = [{ id: "a", state: "fresh" }, { id: "b", state: "fresh" }];
  const s1 = cardsReducer(s0, { type: "remove", id: "a" });
  assert.notEqual(s1, s0);
  assert.equal(s1.length, 1);
  assert.equal(s1[0].id, "b");
});

test("cardsReducer: update patches the matching card without touching siblings", () => {
  const s0 = [{ id: "a", state: "fresh" }, { id: "b", state: "fresh" }];
  const s1 = cardsReducer(s0, { type: "update", id: "a", patch: { state: "grading" } });
  assert.notEqual(s1, s0);
  assert.equal(s1[0].state, "grading");
  assert.equal(s1[1], s0[1], "untouched cards keep reference equality");
});

test("queue cycle: skip a fresh card → shouldRefill flips true", () => {
  // The regression we just shipped to the user: "skipping cards doesn't
  // trigger a prefill". This test simulates the exact handler path:
  // dispatch remove → recompute predicate.
  let cards = [
    { id: "a", state: "fresh" }, { id: "b", state: "fresh" }, { id: "c", state: "fresh" },
  ];
  const base = { inflight: 0, autoGenerate: true, queueTarget: 3, hasKey: true };
  assert.equal(shouldRefill({ ...base, cards }), false, "full queue at target");

  cards = cardsReducer(cards, { type: "remove", id: "a" });
  assert.equal(shouldRefill({ ...base, cards }), true,
    "after skip, predicate must allow refill");
});

test("queue cycle: grade-induced graded card → shouldRefill flips true", () => {
  // The other half: when a card transitions fresh → grading → graded, the
  // graded slot must reopen for refill. shouldRefill already had a unit test
  // for this; this version walks the reducer so we catch any update-action
  // misuse that loses array-reference identity.
  let cards = [
    { id: "a", state: "fresh" }, { id: "b", state: "fresh" }, { id: "c", state: "fresh" },
  ];
  const base = { inflight: 0, autoGenerate: true, queueTarget: 3, hasKey: true };

  cards = cardsReducer(cards, { type: "update", id: "a", patch: { state: "grading" } });
  assert.equal(shouldRefill({ ...base, cards }), false, "grading still holds the slot");

  cards = cardsReducer(cards, { type: "update", id: "a", patch: { state: "graded-fail" } });
  assert.equal(shouldRefill({ ...base, cards }), true, "graded card frees the slot");
});

test("queue cycle: drives the refill loop to target via a fake generator", () => {
  // Stand in for the App: keep state, run shouldRefill, fire fake kickOffOne.
  // Each fake "generation" produces a fresh card by adding to the stack.
  // We run a small loop until the predicate stabilizes — exactly the same
  // shape the React useEffect implements.
  const base = { inflight: 0, autoGenerate: true, queueTarget: 3, hasKey: true };
  let cards = [];
  let _id = 0;
  let safety = 0;
  while (shouldRefill({ ...base, cards })) {
    if (safety++ > 20) throw new Error("refill loop did not converge");
    cards = cardsReducer(cards, { type: "add", card: { id: "g" + (++_id), state: "fresh" } });
  }
  assert.equal(cards.length, 3, "loop must fill exactly to queueTarget");

  // Skipping any card must reopen the predicate.
  cards = cardsReducer(cards, { type: "remove", id: "g2" });
  assert.equal(shouldRefill({ ...base, cards }), true,
    "after skip, predicate must permit another refill cycle");
});

test("renderRuby: consecutive plain chars collapse into one segment", () => {
  const { map, keys } = buildRubyAnnotator([
    { jp: "本", ruby: [["本","ほん"]] },
  ]);
  const out = renderRuby("これは本です。", map, keys);
  // "これは" + ruby("本") + "です。"
  assert.equal(out.length, 3);
  assert.equal(out[0], out[0]); // suppress lint
  assert.deepEqual(out[0], { kind: "plain", text: "これは" });
  assert.equal(out[1].kind, "ruby");
  assert.deepEqual(out[2], { kind: "plain", text: "です。" });
});

// Tests for openai.js. The fetch transport is injectable via configure({fetch}),
// so the generate/approve/grade cycle can be exercised end-to-end without
// burning an actual OpenAI call.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  configure as configureOpenAI,
  setApiKey,
  isRetriable,
  generateDrill,
  approveDrill,
  gradeAnswer,
} from "./openai.js";

// -- isRetriable: pure status-code classifier ----------------------------------

test("isRetriable: server errors retry", () => {
  assert.equal(isRetriable({ status: 500 }), true);
  assert.equal(isRetriable({ status: 502 }), true);
  assert.equal(isRetriable({ status: 503 }), true);
});

test("isRetriable: 408 and 429 retry", () => {
  assert.equal(isRetriable({ status: 408 }), true);
  assert.equal(isRetriable({ status: 429 }), true);
});

test("isRetriable: client errors do not retry", () => {
  assert.equal(isRetriable({ status: 400 }), false);
  assert.equal(isRetriable({ status: 401 }), false);
  assert.equal(isRetriable({ status: 404 }), false);
});

test("isRetriable: network errors retry, others do not", () => {
  assert.equal(isRetriable(new TypeError("network failure")), true);
  assert.equal(isRetriable(new Error("plain error")), false);
  assert.equal(isRetriable(null), false);
  assert.equal(isRetriable(undefined), false);
});

// -- Mock fetch transport ------------------------------------------------------

/**
 * Build a stub fetch that returns the supplied response bodies in order.
 *
 * Each item is either:
 *   - { __httpError: { status, body? } }  → returns a non-2xx response
 *   - any object                          → returns a 200 whose JSON content
 *                                            is JSON.stringify(item) (so the
 *                                            LLM's structured-output schema
 *                                            response shape is preserved,
 *                                            including its own `error` field
 *                                            for no-coherent-combo).
 *
 * Returns { fetch, calls } so tests can assert on what was sent.
 */
function mockFetch(responses) {
  const calls = [];
  let i = 0;
  const fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    const item = responses[Math.min(i, responses.length - 1)];
    i++;
    if (item.__httpError) {
      return {
        ok: false,
        status: item.__httpError.status,
        text: async () => item.__httpError.body || "",
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify(item) } }],
      }),
    };
  };
  return { fetch, calls };
}

const VOCAB = [
  { id: "v1", jp: "本", en: "book" },
  { id: "v2", jp: "読む", en: "to read" },
];
const GRAMMAR = [
  { id: "g1", prompt_en: "I read books.", answer_jp: "私は本を読みます。" },
];

const settings = {
  model: "gpt-5.4-nano",
  service_tier: "default",
  temperature: "1",
  grammar_sample_size: "1",
  vocab_sample_size: "2",
};

function setup(responses) {
  const m = mockFetch(responses);
  configureOpenAI({
    vocab: VOCAB,
    grammar: GRAMMAR,
    getSettingFn: (k, d) => settings[k] ?? d,
    fetch: m.fetch,
  });
  setApiKey("sk-test");
  return m;
}

// -- generateDrill -------------------------------------------------------------

test("generateDrill: happy path returns drill from offered candidates", async () => {
  const m = setup([
    {
      prompt_en: "I read the book.",
      reference_jp: "本を読みます。",
      target_grammar_id: "g1",
      target_grammar_label: "です/ます polite",
      notes: "polite present",
      error: null,
      reason: null,
    },
  ]);
  const drill = await generateDrill();
  assert.equal(drill.prompt_en, "I read the book.");
  assert.equal(drill.target_grammar_id, "g1");
  assert.equal(m.calls.length, 1);
  // Sanity: the user message must carry candidates, since the system
  // prompt no longer contains the full deck.
  const userMsg = JSON.parse(m.calls[0].body.messages[1].content);
  assert.equal(userMsg.task, "generate");
  assert.ok(Array.isArray(userMsg.grammar_candidates));
  assert.ok(userMsg.grammar_candidates.length > 0);
});

test("generateDrill: returns no-coherent-combo → skip-tagged error", async () => {
  setup([{ error: "no-coherent-combo", reason: "candidates don't fit" }]);
  await assert.rejects(
    () => generateDrill(),
    (err) => err.skip === true && /no-coherent-combo/.test(err.message),
  );
});

test("generateDrill: model picks grammar id NOT in candidates → skip-tagged", async () => {
  setup([{
    prompt_en: "x", reference_jp: "y",
    target_grammar_id: "g999",  // not in candidates
    target_grammar_label: "x", notes: "x", error: null, reason: null,
  }]);
  await assert.rejects(
    () => generateDrill(),
    (err) => err.skip === true && /unknown grammar id/.test(err.message),
  );
});

// -- approveDrill --------------------------------------------------------------

test("approveDrill: unanimous yes from 3 judges → passed=true", async () => {
  setup([
    { verdict: "yes", reason: "looks correct" },
    { verdict: "yes", reason: "demonstrates pattern" },
    { verdict: "yes", reason: "fluent" },
  ]);
  const drill = { prompt_en: "x", reference_jp: "y", target_grammar_id: "g1", target_grammar_label: "x", notes: "" };
  const { passed, verdicts } = await approveDrill(drill);
  assert.equal(passed, true);
  assert.equal(verdicts.length, 3);
});

test("approveDrill: one judge says no → passed=false", async () => {
  setup([
    { verdict: "yes", reason: "ok" },
    { verdict: "no",  reason: "particle is wrong" },
    { verdict: "yes", reason: "ok" },
  ]);
  const drill = { prompt_en: "x", reference_jp: "y", target_grammar_id: "g1", target_grammar_label: "x", notes: "" };
  const { passed } = await approveDrill(drill);
  assert.equal(passed, false);
});

// -- gradeAnswer + per-judge callback -----------------------------------------

test("gradeAnswer: onJudge callback fires for each judge", async () => {
  setup([
    { verdict: "yes", reason: "correct" },
    { verdict: "no",  reason: "tense mismatch" },
    { verdict: "yes", reason: "acceptable variation" },
  ]);
  const drill = { prompt_en: "x", reference_jp: "y", target_grammar_id: "g1", target_grammar_label: "x", notes: "" };
  const events = [];
  const { passed, verdicts } = await gradeAnswer(drill, "本を読みます", (i, v) => {
    events.push({ i, verdict: v.verdict });
  });
  assert.equal(events.length, 3, "expected one callback per judge");
  // All three slots should have been signaled.
  assert.deepEqual(new Set(events.map(e => e.i)), new Set([0, 1, 2]));
  assert.equal(passed, false, "one no → fail");
  assert.equal(verdicts.length, 3);
});

test("gradeAnswer: judge transport error becomes a 'no' verdict, not a hang", async () => {
  // Simulate a permanent network failure on every retry by returning 400s
  // (non-retriable) on every call.
  setup([
    { __httpError: { status: 400, body: "{\"error\":{\"message\":\"bad request\"}}" } },
    { __httpError: { status: 400, body: "{\"error\":{\"message\":\"bad request\"}}" } },
    { __httpError: { status: 400, body: "{\"error\":{\"message\":\"bad request\"}}" } },
  ]);
  const drill = { prompt_en: "x", reference_jp: "y", target_grammar_id: "g1", target_grammar_label: "x", notes: "" };
  const { passed, verdicts } = await gradeAnswer(drill, "answer");
  assert.equal(passed, false);
  assert.equal(verdicts.length, 3);
  assert.ok(verdicts.every(v => v.verdict === "no"),
    "exhausted judges should resolve to 'no' so the UI doesn't hang");
});

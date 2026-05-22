// Prompt construction + OpenAI calls + drill-cycle helpers. The SYSTEM_PROMPT
// is built once at module load from VOCAB and GRAMMAR — it must remain
// byte-identical across all calls in a session for OpenAI's automatic prompt
// cache (≥1024-token prefixes) to take effect.

let VOCAB = [];
let GRAMMAR_ALL = [];
let GRAMMAR = [];
let SYSTEM_PROMPT = "";

let apiKey = null;
let getSetting = () => "";  // injected by main

export function configure({ vocab, grammar, getSettingFn }) {
  VOCAB = vocab;
  GRAMMAR_ALL = grammar;
  GRAMMAR = grammar.filter(g => !((g.tags || []).includes("unverified")));
  SYSTEM_PROMPT = buildSystemPrompt();
  if (getSettingFn) getSetting = getSettingFn;
}

export function setApiKey(k) { apiKey = k || null; }
export function hasApiKey() { return typeof apiKey === "string" && apiKey.length > 0; }
export function stats() { return { vocab: VOCAB.length, grammar: GRAMMAR.length, grammarTotal: GRAMMAR_ALL.length }; }

function buildSystemPrompt() {
  return [
    "You are an expert author and grader of JLPT N4 Japanese grammar drills.",
    "",
    "You will receive a JSON instruction in the user message specifying one of three tasks:",
    "  - \"generate\": produce a new drill from offered candidates.",
    "  - \"approve\": judge a candidate drill for correctness before it is shown to the user.",
    "  - \"grade\": judge a user's typed answer against the drill's reference answer.",
    "",
    "Always respond with JSON conforming to the schema attached to the request.",
    "",
    "## Familiar vocabulary",
    "The learner has studied these vocabulary items in their Mochi deck:",
    JSON.stringify(VOCAB),
    "",
    "## Reference grammar examples",
    "Each item below is an English/Japanese sentence pair from the learner's deck.",
    "Each pair exemplifies a specific N4 grammar pattern. Refer to a pair by its id.",
    JSON.stringify(GRAMMAR),
    "",
    "## Generation rules",
    "When the task is \"generate\":",
    "  - The user message includes `grammar_candidates` (a small sampled subset of the reference grammar examples) and `vocab_candidates` (a sampled subset of the familiar vocabulary).",
    "  - Pick EXACTLY ONE item from grammar_candidates as the focus pattern.",
    "  - Identify what N4 grammar pattern that example exemplifies and produce a fresh English prompt + Japanese reference sentence that demonstrates THE SAME pattern.",
    "  - Use 2–5 vocab items from vocab_candidates, plus common Japanese (particles, copula, basic verbs like する/ある/いる) as needed.",
    "  - Do not reuse the candidate's exact sentence.",
    "  - Output: { prompt_en, reference_jp, target_grammar_id, target_grammar_label, notes }",
    "    - target_grammar_id MUST equal the chosen candidate's id.",
    "    - target_grammar_label is a short label naming the pattern, e.g. \"〜たことがある (experience)\" or \"〜なければ (negative conditional)\".",
    "    - notes is a short optional sentence explaining the pattern in English.",
    "  - Optional `user_instructions` may steer style or topic; honour it when feasible but never at the cost of the grammar focus.",
    "  - Be conservative: if you cannot form a clean N4-level drill from the offered candidates, return { error: \"no-coherent-combo\" } instead and a `reason`.",
    "",
    "## Approval rules",
    "When the task is \"approve\":",
    "  - The user message includes a candidate drill: { prompt_en, reference_jp, target_grammar_id, target_grammar_label, notes }.",
    "  - Verdict \"yes\" iff ALL of the following hold:",
    "    a) reference_jp is a correct, natural, N4-level Japanese translation of prompt_en.",
    "    b) reference_jp genuinely exhibits the same N4 grammar pattern as the referenced target_grammar_id example.",
    "    c) prompt_en is fluent unambiguous English; a reasonable N4 learner could translate it without misreading intent.",
    "    d) target_grammar_label correctly names the pattern shown.",
    "  - Otherwise verdict \"no\". Include a one-sentence `reason`.",
    "",
    "## Grading rules",
    "When the task is \"grade\":",
    "  - The user message includes { prompt_en, reference_jp, target_grammar_label, user_answer }.",
    "  - Verdict \"yes\" iff user_answer is a correct N4 translation of prompt_en:",
    "    semantically equivalent, grammatically correct, demonstrating the same target grammar pattern.",
    "    Minor stylistic differences (word order, optional politeness, alternative correct vocab) are OK.",
    "    Wrong particle, wrong tense/aspect, wrong vocabulary that changes meaning, or omission of the target pattern are NOT OK.",
    "  - Include a one-sentence `reason`.",
    "",
    "Be strict but charitable. Accuracy matters more than throughput.",
  ].join("\n");
}

const GENERATE_SCHEMA = {
  name: "drill_generate",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      prompt_en: { type: "string" },
      reference_jp: { type: "string" },
      target_grammar_id: { type: "string" },
      target_grammar_label: { type: "string" },
      notes: { type: "string" },
      error: { type: ["string", "null"] },
      reason: { type: ["string", "null"] },
    },
    required: ["prompt_en", "reference_jp", "target_grammar_id", "target_grammar_label", "notes", "error", "reason"],
  },
};

const JUDGE_SCHEMA = {
  name: "drill_judge",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      verdict: { type: "string", enum: ["yes", "no"] },
      reason: { type: "string" },
    },
    required: ["verdict", "reason"],
  },
};

async function callOpenAI(userPayload, schema) {
  if (!hasApiKey()) throw new Error("no api key");
  const body = {
    model: getSetting("model", "gpt-5"),
    service_tier: getSetting("service_tier", "flex"),
    temperature: parseFloat(getSetting("temperature", "1")),
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: JSON.stringify(userPayload) },
    ],
    response_format: { type: "json_schema", json_schema: schema },
    seed: Math.floor(Math.random() * 1e9),
  };
  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + apiKey,
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    let detail = "";
    try { detail = await resp.text(); } catch (e) {}
    throw new Error("openai " + resp.status + ": " + detail.slice(0, 300));
  }
  const data = await resp.json();
  const text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!text) throw new Error("openai: empty response");
  return JSON.parse(text);
}

function sample(arr, n) {
  const k = Math.min(n, arr.length);
  const idx = new Set();
  const out = [];
  while (out.length < k) {
    const i = Math.floor(Math.random() * arr.length);
    if (idx.has(i)) continue;
    idx.add(i);
    out.push(arr[i]);
  }
  return out;
}

export async function generateDrill() {
  const gN = Math.max(1, parseInt(getSetting("grammar_sample_size", "2"), 10));
  const vN = Math.max(1, parseInt(getSetting("vocab_sample_size", "10"), 10));
  const gCands = sample(GRAMMAR, gN);
  const vCands = sample(VOCAB, vN);
  const inst = getSetting("instructions", "") || "";
  const payload = {
    task: "generate",
    grammar_candidates: gCands,
    vocab_candidates: vCands,
    user_instructions: inst || null,
  };
  const out = await callOpenAI(payload, GENERATE_SCHEMA);
  if (out.error) {
    const err = new Error("generator-skip: " + out.error);
    err.skip = true;
    throw err;
  }
  if (!gCands.some(g => g.id === out.target_grammar_id)) {
    const err = new Error("generator picked unknown grammar id");
    err.skip = true;
    throw err;
  }
  return out;
}

export async function approveDrill(drill) {
  const payload = {
    task: "approve",
    drill: {
      prompt_en: drill.prompt_en,
      reference_jp: drill.reference_jp,
      target_grammar_id: drill.target_grammar_id,
      target_grammar_label: drill.target_grammar_label,
      notes: drill.notes,
    },
  };
  const calls = [0, 1, 2].map(() => callOpenAI(payload, JUDGE_SCHEMA));
  const verdicts = await Promise.all(calls);
  return { passed: verdicts.every(v => v.verdict === "yes"), verdicts };
}

export async function gradeAnswer(drill, userAnswer) {
  const payload = {
    task: "grade",
    prompt_en: drill.prompt_en,
    reference_jp: drill.reference_jp,
    target_grammar_label: drill.target_grammar_label,
    user_answer: userAnswer,
  };
  const calls = [0, 1, 2].map(() => callOpenAI(payload, JUDGE_SCHEMA));
  const verdicts = await Promise.all(calls);
  return { passed: verdicts.every(v => v.verdict === "yes"), verdicts };
}

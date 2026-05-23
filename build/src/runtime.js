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
 * Build the lookup structures used by renderRuby from a vocab array.
 * Vocab entries with no `ruby` field are ignored — they have nothing to add.
 *
 * Returns { map, keys } where:
 *   - map: Map<jp_string, segments>
 *   - keys: array of jp keys sorted longest-first, so renderRuby tries
 *     `日本` before `日` and gets the right reading.
 */
export function buildRubyAnnotator(vocab) {
  const map = new Map();
  for (const v of vocab) {
    if (v && v.jp && Array.isArray(v.ruby) && v.ruby.length > 0) {
      map.set(v.jp, v.ruby);
    }
  }
  const keys = Array.from(map.keys()).sort((a, b) => b.length - a.length);
  return { map, keys };
}

/**
 * Tokenize text into a list of plain / ruby segments using the longest-
 * match-first rule with a kanji-boundary safety check.
 *
 * Critical invariant: we refuse to annotate a match if a kanji character
 * touches the match on either side. Per-kanji readings are deeply
 * context-sensitive (e.g., 寺 reads てら standing alone but じ inside
 * 高円寺; 日本 reads にほん but 日本人 contains an entirely different
 * lexical unit). Without the boundary check, the matcher happily splatters
 * the user's known-readings onto unrelated compounds and prints garbage
 * furigana.
 *
 * The check is intentionally conservative: under-annotate rather than
 * mis-annotate. If the user wants 寺 inside 高円寺 to render with the
 * place-name reading, they must add 高円寺 to their vocab deck.
 *
 *   renderRuby("食べ物が好き", map, keys)
 *   → [
 *       { kind: "ruby", segments: [["食","た"],["べ",null],["物","もの"]] },
 *       { kind: "plain", text: "が好き" },
 *     ]
 *
 *   renderRuby("高円寺の方が", mapWithJustTera, keys)
 *   → [{ kind: "plain", text: "高円寺の方が" }]   // 寺 sits between kanji
 *
 * Consecutive plain characters are collapsed into a single segment.
 */
export function renderRuby(text, map, keys) {
  if (!text) return [];
  const out = [];
  let i = 0;
  while (i < text.length) {
    let matched = null;
    for (const k of keys) {
      if (k.length > text.length - i) continue;
      if (!text.startsWith(k, i)) continue;
      const before = i > 0 ? text[i - 1] : "";
      const after = text[i + k.length] || "";
      if (isKanjiChar(before) || isKanjiChar(after)) continue;
      matched = k;
      break;
    }
    if (matched) {
      out.push({ kind: "ruby", segments: map.get(matched) });
      i += matched.length;
    } else {
      const ch = text[i];
      const last = out[out.length - 1];
      if (last && last.kind === "plain") last.text += ch;
      else out.push({ kind: "plain", text: ch });
      i++;
    }
  }
  return out;
}

/**
 * Is this character a CJK ideograph (kanji)? Covers the basic
 * Unified Ideographs block plus 々 (the iteration mark, which acts as
 * kanji for compound-detection purposes — e.g., 人々).
 */
function isKanjiChar(ch) {
  if (!ch) return false;
  const cp = ch.codePointAt(0);
  return (cp >= 0x4E00 && cp <= 0x9FFF) || cp === 0x3005;
}

/**
 * Reducer used by the cards stack. Lives here so it's testable in isolation
 * — that way we can wire a fake generator to it and prove the queue invariant
 * (`shouldRefill` → kickOff → dispatch add) round-trips end-to-end without
 * needing a real React renderer.
 *
 *   actions: { type: "add",    card }
 *            { type: "update", id, patch }
 *            { type: "remove", id }
 */
export function cardsReducer(state, action) {
  switch (action.type) {
    case "add":    return [...state, action.card];
    case "update": return state.map(c => c.id === action.id ? { ...c, ...action.patch } : c);
    case "remove": return state.filter(c => c.id !== action.id);
    default: return state;
  }
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

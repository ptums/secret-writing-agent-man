// Exact find/replace on a Markdown document, tolerant of the differences between
// text copied from the rendered reader and the stored Markdown: curly vs straight
// quotes, dashes, whitespace/line breaks, and Markdown markers (**, _, `, #, >, list bullets).

// Written as escapes on purpose: several of these look identical to their ASCII targets.
const CHAR_MAP: Record<string, string> = {
  "\u2018": "'", // ‘
  "\u2019": "'", // ’
  "\u201C": '"', // “
  "\u201D": '"', // ”
  "\u2013": "-", // en dash
  "\u2014": "-", // em dash
  "\u2026": "...", // ellipsis
};

// Markdown syntax at the start of a line: headings, blockquotes, list bullets.
const LINE_MARKERS = /^[ \t]*(?:#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+|\d+\.[ \t]+)/gm;
const INLINE_MARKERS = new Set(["*", "_", "`"]);

// Normalized text plus, for each normalized char, the index of the original char it came from.
function normalize(text: string, { caseInsensitive = false } = {}) {
  const ignored = new Uint8Array(text.length);
  for (const m of text.matchAll(LINE_MARKERS)) ignored.fill(1, m.index, m.index + m[0].length);

  let out = "";
  const map: number[] = [];
  let pendingSpace = false;
  for (let i = 0; i < text.length; i++) {
    if (ignored[i] || INLINE_MARKERS.has(text[i])) continue;
    const ch = CHAR_MAP[text[i]] ?? text[i];
    if (/\s/.test(ch)) {
      pendingSpace = out.length > 0;
      continue;
    }
    if (pendingSpace) {
      out += " ";
      map.push(i - 1);
      pendingSpace = false;
    }
    for (const c of caseInsensitive ? ch.toLowerCase() : ch) {
      out += c;
      map.push(i);
    }
  }
  return { out, map };
}

export function normalizeText(text: string) {
  return normalize(text).out;
}

function allIndexes(haystack: string, needle: string) {
  const found: number[] = [];
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + 1)) found.push(i);
  return found;
}

export type Span = { start: number; end: number };
export type FindResult = { ok: true; span: Span } | { ok: false; reason: "not_found" | "ambiguous"; count?: number };

export function findSpan(content: string, needle: string): FindResult {
  const trimmed = needle.trim();
  if (!trimmed) return { ok: false, reason: "not_found" };

  const exact = allIndexes(content, trimmed);
  if (exact.length === 1) return { ok: true, span: { start: exact[0], end: exact[0] + trimmed.length } };
  if (exact.length > 1) return { ok: false, reason: "ambiguous", count: exact.length };

  for (const caseInsensitive of [false, true]) {
    const doc = normalize(content, { caseInsensitive });
    const want = normalize(trimmed, { caseInsensitive }).out;
    if (!want) break;
    const hits = allIndexes(doc.out, want);
    if (hits.length > 1) return { ok: false, reason: "ambiguous", count: hits.length };
    if (hits.length === 1) {
      const start = doc.map[hits[0]];
      const end = doc.map[hits[0] + want.length - 1] + 1;
      return { ok: true, span: { start, end } };
    }
  }
  return { ok: false, reason: "not_found" };
}

export type EditResult =
  { ok: true; content: string } | { ok: false; reason: "not_found" | "ambiguous"; count?: number };

export function applyEdit(content: string, find: string, replace: string): EditResult {
  const found = findSpan(content, find);
  if (!found.ok) return found;
  let { start, end } = found.span;

  if (!replace.trim()) {
    // Removing text: if that empties its line(s), take the leftover Markdown markers
    // ("## ", "**", "- ") with it rather than leaving orphans behind.
    const lineStart = content.lastIndexOf("\n", start - 1) + 1;
    if (/^[\s#>*_`\-+\d.]*$/.test(content.slice(lineStart, start))) start = lineStart;
    const nl = content.indexOf("\n", end);
    const lineEnd = nl === -1 ? content.length : nl;
    if (/^[\s*_`]*$/.test(content.slice(end, lineEnd))) end = lineEnd;
    // Removing the last sentence of a line takes the space before it too ("iOS. Android…").
    if (end === lineEnd && start > lineStart && content[start - 1] === " ") start--;
  }

  // Only whitespace-only lines are cleaned up: trailing double spaces elsewhere are
  // Markdown hard line breaks and must survive.
  const next = (content.slice(0, start) + replace + content.slice(end))
    .replace(/\n[ \t]+(?=\n)/g, "\n")
    // A sentence removed from the start of a paragraph leaves a leading space behind.
    .replace(/\n (?=[^\s\-*+\d>#])/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { ok: true, content: next };
}

// True when pasted text is mostly a quote of the document (e.g. "drop this: <passage>"),
// so it shouldn't be saved as new source material.
export function isQuoteOf(pasted: string, content: string) {
  if (!content.trim()) return false;
  const doc = normalize(content, { caseInsensitive: true }).out;
  const lines = pasted
    .split(/\n+|(?<=[.!?])\s+/)
    .map((l) => normalize(l, { caseInsensitive: true }).out)
    .filter((l) => l.length >= 20);
  const total = lines.reduce((n, l) => n + l.length, 0);
  if (!total) return false;
  const quoted = lines.filter((l) => doc.includes(l)).reduce((n, l) => n + l.length, 0);
  return quoted / total >= 0.6;
}

// Levenshtein distance, for matching the user's typos ("reach" for "real").
function editDistance(a: string, b: string) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length];
}

const wordsOf = (text: string) => normalizeText(text).toLowerCase().split(" ").filter(Boolean);
const similarWords = (a: string, b: string) =>
  a === b || (Math.min(a.length, b.length) >= 3 && editDistance(a, b) <= Math.max(1, Math.floor(b.length / 3)));

// The user quotes phrases loosely: different case, straight quotes, a typo or two
// ("let's bring reach" for "Let’s bring real"). Returns the exact matching text from
// `text`, or null if nothing is close enough.
export function resolvePhrase(text: string, phrase: string) {
  const found = findSpan(text, phrase);
  if (found.ok) return text.slice(found.span.start, found.span.end);

  const want = wordsOf(phrase);
  if (!want.length) return null;
  const words = [...text.matchAll(/\S+/g)].map((m) => ({ raw: m[0], start: m.index!, norm: wordsOf(m[0])[0] ?? "" }));
  let best: { score: number; i: number; lastExact: boolean } | null = null;
  for (let i = 0; i + want.length <= words.length; i++) {
    const window = words.slice(i, i + want.length);
    const score = window.filter((w, k) => similarWords(w.norm, want[k])).length;
    if (!best || score > best.score) best = { score, i, lastExact: window[want.length - 1].norm === want.at(-1) };
  }
  if (!best || best.score < Math.ceil(want.length * 0.6)) return null;
  // A typo in the last word often means the user trailed off mid-phrase ("let's bring reach"
  // for "Let’s bring real change"), so take the next word too, unless it's filler.
  let endWord = best.i + want.length - 1;
  const next = words[endWord + 1];
  if (!best.lastExact && next && !/^(and|or|to|the|a|an|of|for|in|on|with|your|our)$/.test(next.norm)) endWord++;
  const start = words[best.i].start;
  const end = words[endWord].start + words[endWord].raw.length;
  return text.slice(start, end).replace(/[.,;:!?]+$/, (p) => (/[.,;:!?]$/.test(phrase.trim()) ? p : ""));
}

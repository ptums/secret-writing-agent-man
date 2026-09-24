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
  }

  // Only whitespace-only lines are cleaned up: trailing double spaces elsewhere are
  // Markdown hard line breaks and must survive.
  const next = (content.slice(0, start) + replace + content.slice(end))
    .replace(/\n[ \t]+(?=\n)/g, "\n")
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

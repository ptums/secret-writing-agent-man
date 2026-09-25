import { normalizeText } from "@/lib/textEdit";

// Mechanical checks the editor runs on every draft and revision. They're cheap, exact,
// and catch what an 8B model reviewer misses (invented days, long sentences). Findings
// with a `quote` point at exact text the editor can fix; the rest are document-level.

// "serious" findings (facts, structure) send a draft back to the writer; "style" ones don't.
export type Finding = { quote?: string; problem: string; severity: "serious" | "style" };

export type CheckContext = {
  // Everything a fact may come from: brief, source material, the user's instructions and lines.
  allowedText: string;
  keep: string[]; // the user's own lines: never flagged
  removed: string[]; // text the user deleted: must not come back
  // From the source's "Goals" and "Out of scope" sections (see readSourceRules).
  goalTokens?: string[];
  outOfScope?: string[];
};

const BULLET = /^\s*[-*+•]\s+/;
const NUMBERED = /^\s*\d+[.)]\s+/;
const SECTION_WORDS =
  /problem|context|overview|summary|background|audience|user|persona|goal|scope|metric|success|kpi|target|objective|feature|requirement|pricing|brand|voice|timeline|milestone|risk|question|stor(y|ies)|acceptance|launch|design|content|competitor|budget/i;

// A section heading in pasted or exported PRD text: Markdown "#", or a short title line
// (optionally numbered, like "4. Success Metric") that names a typical PRD section.
// Bullets are never headings.
function isSectionHeading(line: string) {
  if (BULLET.test(line)) return false;
  if (/^#{1,6}\s/.test(line)) return true;
  const title = line.replace(NUMBERED, "").trim();
  return /^[A-Z0-9][^.!?]{0,60}:?$/.test(title) && SECTION_WORDS.test(title);
}

// "A blog, a full portfolio, pricing pages, or claims about compliance (e.g., HIPAA)"
// → ["blog", "full portfolio", "pricing pages", "HIPAA"]. Long phrases are dropped:
// they rarely appear verbatim in copy and are mostly template text.
function scopePhrases(line: string) {
  return (
    line
      // Parentheses that give examples of what's excluded count ("(e.g., HIPAA)");
      // ones that clarify what IS included don't ("Android app (iOS and web only)").
      .replace(/\(([^)]*)\)/g, (_, inner: string) =>
        /^\s*(e\.g\.|such as|like|including)/i.test(inner) ? `, ${inner},` : ",",
      )
      .replace(BULLET, "")
      .replace(NUMBERED, "")
      .split(/[,;/()]|\bor\b|\band\b|e\.g\.:?|i\.e\.:?/i)
      .map((p) =>
        p
          .trim()
          .replace(/^(a|an|the|any|some|no)\s+/i, "")
          .replace(/\s+app$/i, "")
          .replace(/[.:]+$/, ""),
      )
      .filter((p) => p.length >= 3 && p.split(/\s+/).length <= 4 && !/^(what|you|we|this|that|it|they|v\d)\b/i.test(p))
  );
}

// PRDs state goals ("Cut no-shows by 50%") and out-of-scope features ("Android app")
// that must never appear in copy as results or existing features.
export function readSourceRules(source: string | null | undefined) {
  const goalTokens = new Set<string>();
  const outOfScope = new Set<string>();
  let section: "goals" | "out" | null = null;
  for (const raw of (source ?? "").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (isSectionHeading(line)) {
      // Checked before "goal": "Non-goals" is an out-of-scope list.
      // Judged by how the title starts: "3. Goals and Non-Goals" is a goals section.
      const title = line.replace(/^#{1,6}\s*/, "").replace(NUMBERED, "");
      section = /^(out of scope|non-goals?|not (in|at) launch|later|future)/i.test(title)
        ? "out"
        : /goal|target|success|metric|kpi|objective/i.test(line)
          ? "goals"
          : null;
      continue;
    }
    if (section === "goals" || /\b(goal|target|aim)\b/i.test(line)) {
      for (const re of SPECIFICS) for (const m of line.matchAll(re)) goalTokens.add(m[0]);
    }
    if (section === "out") for (const phrase of scopePhrases(line)) outOfScope.add(phrase);
  }
  return { goalTokens: [...goalTokens], outOfScope: [...outOfScope] };
}

export const MAX_SENTENCE_WORDS = 25;
export const TARGET_SENTENCE_WORDS = 15;
export const MAX_GRADE = 10;

// Keep in sync with the filler list in the writer's SYSTEM_PROMPT.
export const BANNED_PHRASES = [
  "in today's fast-paced world",
  "unlock",
  "elevate",
  "leverage",
  "game-changer",
  "game changer",
  "made with love",
];

// Section types from FORMAT_GUIDANCE that sometimes leak out as literal headings.
export const LITERAL_HEADINGS = /^#{1,6}\s*(hero|features?(,.*)?|final cta|cta|call to action|section \d+)\s*$/i;

const PREAMBLE = /^(here(?:'|’)?s|here is|sure|certainly|below is|of course)\b/i;

// Specifics that must come from the brief or sources: prices, percentages, counts with
// units, durations, weekdays.
// Digit groups are "1,234"-style only, so "$18," (price then a comma) reads as "$18".
const SPECIFICS = [
  /\$\s?\d+(?:,\d{3})*(?:\.\d{1,2})?/g,
  /\b\d+(?:\.\d+)?\s?%/g,
  /\b\d+(?:,\d{3})*(?:\.\d+)?[\s-]?(?:hours?|hrs?|minutes?|mins?|days?|weeks?|months?|years?|times|x|clients|customers|users|families|people|patients|practices)\b/gi,
  /\b(?:mon|tues|wednes|thurs|fri|satur|sun)days?\b/gi,
  /\b24\/7\b/g,
];

// Markdown → the plain lines a reader sees; bracketed placeholders are allowed and dropped.
function plainLines(content: string) {
  return content
    .split("\n")
    .map((l) =>
      l
        .replace(/^[ \t]*(?:#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+|\d+\.[ \t]+)/, "")
        .replace(/[*_`]/g, "")
        .trim(),
    )
    .filter(Boolean);
}

export function sentences(content: string) {
  return plainLines(content).flatMap((line) => line.split(/(?<=[.!?])\s+/).filter((s) => /[a-z]/i.test(s)));
}

const words = (s: string) => s.match(/[A-Za-z0-9'’$%-]+/g) ?? [];

function syllables(word: string) {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!w) return 0;
  const groups = w.match(/[aeiouy]+/g)?.length ?? 1;
  return Math.max(1, w.endsWith("e") && groups > 1 ? groups - 1 : groups);
}

// Flesch–Kincaid grade level.
export function readingGrade(content: string) {
  const sents = sentences(content);
  const all = sents.flatMap(words);
  if (!sents.length || !all.length) return 0;
  const syl = all.reduce((n, w) => n + syllables(w), 0);
  return 0.39 * (all.length / sents.length) + 11.8 * (syl / all.length) - 15.59;
}

// "14-day" vs "14 days", "$29" vs "$29/month": compare with spaces, hyphens, and plurals removed.
const squash = (s: string) => normalizeText(s).toLowerCase().replace(/[\s-]/g, "");

function isSupported(token: string, allowed: string) {
  const t = squash(token);
  return allowed.includes(t) || (t.endsWith("s") && allowed.includes(t.slice(0, -1)));
}

// Specifics in `text` that the allowed text doesn't support.
export function unsupportedSpecifics(text: string, allowedText: string) {
  const allowed = squash(allowedText);
  const cleaned = text.replace(/\[[^\]]*\]/g, "");
  return SPECIFICS.flatMap((re) => [...cleaned.matchAll(re)].map((m) => m[0])).filter((t) => !isSupported(t, allowed));
}

export function runChecks(content: string, ctx: CheckContext): Finding[] {
  const findings: Finding[] = [];
  const keep = ctx.keep.map((k) => normalizeText(k).toLowerCase());
  const isUsersOwn = (s: string) => {
    const n = normalizeText(s).toLowerCase();
    return keep.some((k) => k.includes(n) || n.includes(k));
  };
  const withoutPlaceholders = content.replace(/\[[^\]]*\]/g, "");
  const allowed = squash(ctx.allowedText);

  const firstLine = content.trim().split("\n")[0] ?? "";
  if (PREAMBLE.test(firstLine.trim())) {
    findings.push({
      quote: firstLine.trim(),
      problem: "Preamble or note to the user; the piece must start with the deliverable itself.",
      severity: "serious",
    });
  }

  for (const line of content.split("\n")) {
    if (LITERAL_HEADINGS.test(line.trim())) {
      findings.push({
        quote: line.trim(),
        problem: "A section label used as a heading; write a real headline instead.",
        severity: "serious",
      });
    }
  }

  const sents = sentences(withoutPlaceholders);
  for (const s of sents) {
    if (isUsersOwn(s)) continue;
    const n = words(s).length;
    if (n > MAX_SENTENCE_WORDS) {
      findings.push({
        quote: s,
        problem: `Sentence is ${n} words; the limit is ${MAX_SENTENCE_WORDS}. Split or tighten it.`,
        severity: "style",
      });
    }
    const lower = s.toLowerCase().replace(/’/g, "'");
    const banned = BANNED_PHRASES.find((p) => lower.includes(p));
    if (banned) findings.push({ quote: s, problem: `Uses the banned filler "${banned}".`, severity: "style" });
    for (const re of SPECIFICS) {
      for (const m of s.matchAll(re)) {
        if (!isSupported(m[0], allowed)) {
          findings.push({
            quote: s,
            problem: `"${m[0]}" isn't in the brief or source material. Remove it or use a [placeholder].`,
            severity: "serious",
          });
        }
      }
    }
  }

  for (const r of ctx.removed) {
    if (normalizeText(r).length >= 20 && findSpanLoose(content, r)) {
      findings.push({ quote: r, problem: "The user removed this text; it must not come back.", severity: "serious" });
    }
  }

  for (const s of sents) {
    if (isUsersOwn(s)) continue;
    const plainS = squash(s);
    // Framed as an aim ("built to cut no-shows by 50%") is fine; stated as fact is not, and
    // "reminders help cut no-shows by 50%" is still a stated result.
    if (!/\b(goal|aim|designed|built to|target)/i.test(s)) {
      for (const token of ctx.goalTokens ?? []) {
        if (plainS.includes(squash(token))) {
          findings.push({
            quote: s,
            problem: `"${token}" is a goal in the source, not a proven result. Don't state it as fact: say what the product is built to do, or remove the number.`,
            severity: "serious",
          });
        }
      }
    }
    const lowerS = normalizeText(s).toLowerCase();
    for (const item of ctx.outOfScope ?? []) {
      if (lowerS.includes(normalizeText(item).toLowerCase())) {
        findings.push({
          quote: s,
          problem: `"${item}" is out of scope in the source. Don't mention it or promise it; remove this.`,
          severity: "serious",
        });
      }
    }
  }

  const docLower = normalizeText(content).toLowerCase();
  for (const k of ctx.keep) {
    if (!docLower.includes(normalizeText(k).toLowerCase())) {
      findings.push({
        problem: `The user's own line is missing and must appear word for word: "${k}"`,
        severity: "serious",
      });
    }
  }

  // A heading with nothing under it (seen in a shipped landing page).
  for (const m of content.matchAll(/^(#{1,6}\s.+?)\s*\n+(?=#{1,6}\s|\s*$(?![\s\S]))/gm)) {
    findings.push({
      quote: m[1].trim(),
      problem: "This section has a heading but no text under it.",
      severity: "serious",
    });
  }

  const short = sents.filter((s) => words(s).length <= TARGET_SENTENCE_WORDS).length;
  if (sents.length >= 5 && short / sents.length < 0.6) {
    findings.push({
      problem: `Only ${Math.round((100 * short) / sents.length)}% of sentences are ${TARGET_SENTENCE_WORDS} words or fewer; most should be.`,
      severity: "style",
    });
  }
  const grade = readingGrade(withoutPlaceholders);
  if (grade >= MAX_GRADE) {
    findings.push({
      problem: `Reading level is about grade ${grade.toFixed(1)}; it must be below ${MAX_GRADE}. Use shorter sentences and plainer words.`,
      severity: "style",
    });
  }
  return findings;
}

function findSpanLoose(content: string, text: string) {
  return normalizeText(content).toLowerCase().includes(normalizeText(text).toLowerCase());
}

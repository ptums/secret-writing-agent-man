import { diffLines } from "diff";

// A truthful summary of what a change did, computed from the two versions rather than
// taken from the model's description of what it meant to do.

export const CHANGES_HEADER = "What changed:";
const MAX_LINES = 8;
const MAX_LINE_CHARS = 200;

// Strip Markdown so lines read like the rendered document.
function plain(line: string) {
  return line
    .replace(/^[ \t]*(?:#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+|\d+\.[ \t]+)/, "")
    .replace(/[*_`]/g, "")
    .trim();
}

export function summarizeChanges(before: string, after: string) {
  const lines: { sign: "-" | "+"; text: string }[] = [];
  for (const part of diffLines(before, after)) {
    if (!part.added && !part.removed) continue;
    for (const raw of part.value.split("\n")) {
      const text = plain(raw);
      if (text) lines.push({ sign: part.added ? "+" : "-", text });
    }
  }
  // Lines that only moved or changed formatting appear on both sides; they aren't real changes.
  const removed = new Set(lines.filter((l) => l.sign === "-").map((l) => l.text));
  const added = new Set(lines.filter((l) => l.sign === "+").map((l) => l.text));
  const real = lines.filter((l) => !(l.sign === "-" ? added : removed).has(l.text));

  if (real.length === 0) return { changed: false, event: "No changes were made to the document.", added: [] };

  const shown = real
    .slice(0, MAX_LINES)
    .map(
      (l) =>
        `${l.sign === "-" ? "−" : "+"} ${l.text.length > MAX_LINE_CHARS ? `${l.text.slice(0, MAX_LINE_CHARS)}…` : l.text}`,
    );
  if (real.length > MAX_LINES) shown.push(`…and ${real.length - MAX_LINES} more changed lines`);
  return {
    changed: true,
    event: [CHANGES_HEADER, ...shown].join("\n"),
    // Added lines, for highlighting in the reader.
    added: real.filter((l) => l.sign === "+").map((l) => l.text),
  };
}

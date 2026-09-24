// Other wordings the editor offered for a line, stored as a chat event so the user can
// swap one in with a click:
//
//   Other options:
//   = <the wording currently in the document>
//   • <option>
//   • <option>

export const OPTIONS_HEADER = "Other options:";

export type LineOptions = { current: string; options: string[] };

export function formatOptions({ current, options }: LineOptions) {
  return [OPTIONS_HEADER, `= ${current}`, ...options.map((o) => `• ${o}`)].join("\n");
}

export function parseOptions(content: string): LineOptions | null {
  const [header, currentLine, ...rest] = content.split("\n");
  if (header !== OPTIONS_HEADER || !currentLine?.startsWith("= ")) return null;
  return {
    current: currentLine.slice(2),
    options: rest.filter((l) => l.startsWith("• ")).map((l) => l.slice(2)),
  };
}

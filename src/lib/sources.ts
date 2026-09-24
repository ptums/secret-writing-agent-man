// Source material (PRDs, user stories, notes) is stored on each document as labeled
// sections, so a re-fetched Google Doc replaces its old copy instead of piling up.
//
//   ===== SOURCE gdoc:1AbC… | Google Doc: "Groomly PRD" =====
//   …text…

const HEADER = /^===== SOURCE (\S+) \| (.*) =====$/gm;

// Keeps a single source from crowding the writer's 16k-token context.
export const MAX_SOURCE_CHARS = 40_000;

// A user message this long is pasted material, not chat.
export const PASTE_MIN_CHARS = 400;

type Section = { key: string; label: string; text: string };

function parse(material: string | null): Section[] {
  if (!material?.trim()) return [];
  const headers = [...material.matchAll(HEADER)];
  // Material saved before sections existed becomes one legacy section.
  if (headers.length === 0) return [{ key: "legacy", label: "Earlier source material", text: material.trim() }];
  return headers.map((h, i) => ({
    key: h[1],
    label: h[2],
    text: material.slice(h.index! + h[0].length, headers[i + 1]?.index ?? material.length).trim(),
  }));
}

export function mergeSource(material: string | null, source: Section) {
  const sections = parse(material).filter((s) => s.key !== source.key);
  sections.push(source);
  return sections.map((s) => `===== SOURCE ${s.key} | ${s.label} =====\n${s.text}`).join("\n\n");
}

export function truncateSource(text: string) {
  return text.length > MAX_SOURCE_CHARS
    ? { text: `${text.slice(0, MAX_SOURCE_CHARS)}\n[…truncated]`, truncated: true }
    : { text, truncated: false };
}

// ---- Google Docs --------------------------------------------------------------

const GDOC_LINK = /https?:\/\/docs\.google\.com\/document\/(?:u\/\d+\/)?d\/([a-zA-Z0-9_-]{20,})[^\s)>\]]*/g;

export function findGoogleDocLinks(text: string) {
  const seen = new Map<string, string>();
  for (const m of text.matchAll(GDOC_LINK)) if (!seen.has(m[1])) seen.set(m[1], m[0]);
  return [...seen].map(([id, url]) => ({ id, url }));
}

export type FetchedDoc = { ok: true; title: string; text: string } | { ok: false; reason: string };

// Uses Google's export endpoint, which works without auth for docs shared as
// "Anyone with the link". Private docs redirect to a sign-in page (HTML).
export async function fetchGoogleDoc(id: string): Promise<FetchedDoc> {
  for (const format of ["md", "txt"]) {
    let res: Response;
    try {
      res = await fetch(`https://docs.google.com/document/d/${id}/export?format=${format}`, {
        redirect: "follow",
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      return { ok: false, reason: "Google Docs didn't respond. Try again in a moment." };
    }
    if (res.status === 404) return { ok: false, reason: "that document doesn't exist, or the link is incomplete." };
    const type = res.headers.get("content-type") ?? "";
    if (res.ok && type.includes("text/html")) {
      return {
        ok: false,
        reason:
          'it isn\'t shared publicly. In Google Docs, click Share → General access → "Anyone with the link" (Viewer), then paste the link again.',
      };
    }
    if (!res.ok) continue; // e.g. the format isn't available; try the next one
    const text = (await res.text()).replace(/^\uFEFF/, "").trim(); // strip a leading byte-order mark
    if (!text) return { ok: false, reason: "the document is empty." };
    return { ok: true, title: titleFrom(res.headers.get("content-disposition")) ?? "Untitled Google Doc", text };
  }
  return { ok: false, reason: "Google Docs wouldn't export it." };
}

// Content-Disposition: attachment; filename="PRD.md"; filename*=UTF-8''Groomly%20PRD.md
function titleFrom(disposition: string | null) {
  if (!disposition) return null;
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  const plain = disposition.match(/filename="([^"]+)"/i)?.[1];
  const name = encoded ? decodeURIComponent(encoded) : plain;
  return name?.replace(/\.(md|txt)$/i, "").trim() || null;
}

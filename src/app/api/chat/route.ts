import { z } from "zod";
import { runDiscussionTurn } from "@/agents/discussion";
import { getDocument, recentChatMessages, saveChatMessage, setSourceMaterial } from "@/db/queries";
import type { Document } from "@/db/schema";
import {
  PASTE_MIN_CHARS,
  fetchGoogleDoc,
  findGoogleDocLinks,
  mergeSource,
  truncateSource,
} from "@/lib/sources";

const Uuid = z.string().uuid();
const Body = z.object({
  message: z.string().trim().min(1),
  // Every conversation belongs to a document: the one that's open.
  activeDocumentId: Uuid,
});

export async function GET(request: Request) {
  const threadId = Uuid.safeParse(new URL(request.url).searchParams.get("threadId"));
  if (!threadId.success) return Response.json({ error: "threadId is required" }, { status: 400 });
  return Response.json(await recentChatMessages(threadId.data, 100));
}

export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json());
  if (!parsed.success) return Response.json({ error: "Invalid request" }, { status: 400 });
  const { message, activeDocumentId: threadId } = parsed.data;

  const doc = await getDocument(threadId);
  if (!doc) return Response.json({ error: "Document not found" }, { status: 404 });

  const history = await recentChatMessages(threadId, 20);
  await saveChatMessage(threadId, "user", message);

  try {
    // Sources are attached in code, before the model runs: small models are
    // unreliable at deciding to call a "fetch this link" tool themselves.
    const { doc: threadDoc, notices, notes } = await attachSources(doc, message);
    for (const notice of notices) await saveChatMessage(threadId, "event", notice);

    const { reply, documentId } = await runDiscussionTurn({ message, history, threadDoc, notes });
    await saveChatMessage(threadId, "assistant", reply, documentId);
    return Response.json({ reply, documentId, notices });
  } catch (err) {
    console.error("[chat]", err);
    const reply = `Something went wrong talking to the model: ${err instanceof Error ? err.message : String(err)}. Is Ollama running?`;
    return Response.json({ reply, documentId: null, notices: [] }, { status: 502 });
  }
}

// Saves Google Docs linked in the message, and long pasted text, as the document's
// source material. Returns user-facing notices and notes for the model.
async function attachSources(doc: Document, message: string) {
  let material = doc.sourceMaterial;
  const notices: string[] = [];
  const notes: string[] = [];

  const links = findGoogleDocLinks(message);
  for (const link of links) {
    const fetched = await fetchGoogleDoc(link.id);
    if (!fetched.ok) {
      notices.push(`Couldn't read the Google Doc: ${fetched.reason}`);
      notes.push(`[The linked Google Doc could not be read: ${fetched.reason} Tell the user; don't write from it.]`);
      continue;
    }
    const { text, truncated } = truncateSource(fetched.text);
    material = mergeSource(material, { key: `gdoc:${link.id}`, label: `Google Doc: "${fetched.title}"`, text });
    const words = fetched.text.split(/\s+/).length.toLocaleString();
    notices.push(
      `Read Google Doc "${fetched.title}" (${words} words) and saved it to this document's sources.` +
        (truncated ? " It's very long, so only the first part was kept." : ""),
    );
    notes.push(`[Read the linked Google Doc "${fetched.title}" and saved it as source material for the writer.]`);
  }

  // Pasted material: whatever's left once the links are removed, if it's long enough.
  let pasted = message;
  for (const link of links) pasted = pasted.replace(link.url, "");
  pasted = pasted.trim();
  if (pasted.length >= PASTE_MIN_CHARS) {
    const { text } = truncateSource(pasted);
    const when = new Date().toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
    material = mergeSource(material, { key: `paste:${Date.now()}`, label: `Pasted in chat, ${when}`, text });
    notices.push(`Saved your pasted text (${pasted.split(/\s+/).length.toLocaleString()} words) to this document's sources.`);
  }

  const updated = material !== doc.sourceMaterial ? await setSourceMaterial(doc.id, material!) : doc;
  return { doc: updated, notices, notes };
}

import { z } from "zod";
import { getChatMessage, getDocument, reviseDocument, saveChatMessage, updateChatMessage } from "@/db/queries";
import { summarizeChanges } from "@/lib/changes";
import { formatOptions, parseOptions } from "@/lib/options";
import { applyEdit } from "@/lib/textEdit";

const Body = z.object({ eventId: z.string().uuid(), choice: z.string().min(1) });

// "Use" on one of the editor's other wordings: swap it in exactly, no model involved.
export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json());
  if (!parsed.success) return Response.json({ error: "Invalid request" }, { status: 400 });
  const { eventId, choice } = parsed.data;

  const event = await getChatMessage(eventId);
  const options = event?.role === "event" ? parseOptions(event.content) : null;
  if (!event || !options || !options.options.includes(choice)) {
    return Response.json({ error: "That option is no longer available." }, { status: 404 });
  }
  const doc = await getDocument(event.threadId);
  if (!doc) return Response.json({ error: "Document not found" }, { status: 404 });

  const result = applyEdit(doc.content, options.current, choice);
  if (!result.ok) {
    return Response.json(
      { error: "That line has changed since these options were made. Ask the assistant for new ones." },
      { status: 409 },
    );
  }
  // The user picked it, so it counts as their approved wording (kind "edit").
  const updated = await reviseDocument(
    doc.id,
    { content: result.content },
    { kind: "edit", instructions: `Picked option "${choice}"`, find: options.current, replace: choice },
  );
  const summary = summarizeChanges(doc.content, result.content);
  const change = await saveChatMessage(doc.id, "event", summary.event);
  // The swapped-out wording becomes an option, so the user can switch back.
  const optionsEvent = await updateChatMessage(
    event.id,
    formatOptions({ current: choice, options: [...options.options.filter((o) => o !== choice), options.current] }),
  );
  return Response.json({ document: updated, change, optionsEvent, highlights: summary.added });
}

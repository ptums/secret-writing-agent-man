import { z } from "zod";
import { runDiscussionTurn } from "@/agents/discussion";
import { recentChatMessages, saveChatMessage } from "@/db/queries";

const Body = z.object({
  message: z.string().trim().min(1),
  activeDocumentId: z.string().uuid().nullable().optional(),
});

export async function GET() {
  return Response.json(await recentChatMessages(100));
}

export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json());
  if (!parsed.success) return Response.json({ error: "Invalid request" }, { status: 400 });
  const { message, activeDocumentId = null } = parsed.data;

  const history = await recentChatMessages(20);
  await saveChatMessage("user", message);

  try {
    const { reply, documentId } = await runDiscussionTurn({ message, history, activeDocumentId });
    await saveChatMessage("assistant", reply, documentId);
    return Response.json({ reply, documentId });
  } catch (err) {
    console.error("[chat]", err);
    const reply = `Something went wrong talking to the model: ${err instanceof Error ? err.message : String(err)}. Is Ollama running?`;
    return Response.json({ reply, documentId: null }, { status: 502 });
  }
}

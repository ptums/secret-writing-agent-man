import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { ChatMessage } from "@/db/schema";
import { discussionModel } from "./models";

// The writer and editor never see the chat. Every handoff carries two parts:
//   Request: one explicit instruction from the chat agent ("Write an essay about…")
//   Conversation context: a summary of the actual chat, written by a separate call that
//   reads the real messages, so details don't depend on the router's memory.
// The two are stored together as the document's brief, so later revisions see them too.

const SUMMARY_PROMPT = `You summarize a conversation between a user and a writing studio's account lead, for a writer who never saw it.

Write 2 to 6 sentences in the third person ("The user…"). Include:
- what they talked about
- facts, details, and examples the user gave
- the user's preferences, likes, dislikes, and constraints
- anything the user asked to include or avoid, and the tone or audience they want

Only include what the user actually said. Never add a tone, audience, or thing to avoid unless the user stated it; if unsure, leave it out. Don't add advice or opinions, and don't describe the account lead's replies. Write plain sentences, no headings or lists.`;

// Per message, so a pasted PRD doesn't crowd the summary; sources reach the writer separately.
const MAX_MESSAGE_CHARS = 1200;
const MAX_MESSAGES = 30;

export async function summarizeConversation(history: ChatMessage[], currentMessage: string) {
  const turns = [
    ...history
      .filter((m) => m.role === "user" || m.role === "assistant")
      .slice(-MAX_MESSAGES)
      .map((m) => ({ role: m.role, content: m.content })),
    { role: "user" as const, content: currentMessage },
  ];
  // A single message has nothing to summarize: the request already says it all.
  if (turns.filter((t) => t.role === "user").length < 2) return "";

  const transcript = turns
    .map((t) => {
      const text = t.content.length > MAX_MESSAGE_CHARS ? `${t.content.slice(0, MAX_MESSAGE_CHARS)} […]` : t.content;
      return `${t.role === "user" ? "User" : "Account lead"}: ${text}`;
    })
    .join("\n\n");
  const response = await discussionModel().invoke([new SystemMessage(SUMMARY_PROMPT), new HumanMessage(transcript)]);
  return response.text.trim();
}

export function formatBrief(request: string, context: string) {
  return context ? `Request: ${request}\n\nConversation context: ${context}` : request;
}

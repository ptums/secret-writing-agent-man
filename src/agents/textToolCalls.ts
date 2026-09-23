import { AIMessage } from "@langchain/core/messages";
import { createMiddleware } from "langchain";

// Llama 3.x on Ollama sometimes writes a tool call as JSON in its reply text
// (`{"name": "search_documents", "parameters": {...}}`) instead of emitting a
// structured tool call. This middleware finds that JSON and turns it into a real
// tool call so the agent loop runs the tool instead of showing JSON to the user.
export function textToolCallMiddleware(toolNames: string[]) {
  return createMiddleware({
    name: "TextToolCalls",
    wrapModelCall: async (request, handler) => {
      const response = await handler(request);
      if (response.tool_calls?.length) return response;

      const call = extractToolCall(response.text, toolNames);
      if (!call) return response;
      return new AIMessage({
        content: "",
        tool_calls: [{ id: `text_call_${crypto.randomUUID()}`, name: call.name, args: call.args, type: "tool_call" }],
      });
    },
  });
}

function extractToolCall(text: string, toolNames: string[]) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    const args = parsed.parameters ?? parsed.arguments ?? parsed.args;
    if (typeof parsed.name === "string" && toolNames.includes(parsed.name) && args && typeof args === "object") {
      return { name: parsed.name as string, args: args as Record<string, unknown> };
    }
  } catch {
    // Not JSON — a normal reply.
  }
  return null;
}

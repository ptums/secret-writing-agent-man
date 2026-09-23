import { ChatOllama } from "@langchain/ollama";

const baseUrl = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
// Both agents share one context size: if they run the same model with different
// sizes, Ollama reloads it on every handoff.
// 16k leaves room for a pasted PRD plus the system prompt and chat history.
const numCtx = 16384;

// Low temperature: this model routes requests and calls tools, so it should be predictable.
export function discussionModel() {
  return new ChatOllama({
    baseUrl,
    model: process.env.DISCUSSION_MODEL ?? "qwen3:8b",
    temperature: 0.2,
    numCtx,
    // Routing doesn't need reasoning traces; with thinking on, qwen3 takes ~40s per turn.
    think: false,
  });
}

// Higher temperature for more varied copy.
export function writerModel() {
  return new ChatOllama({
    baseUrl,
    model: process.env.WRITER_MODEL ?? "qwen3:8b",
    temperature: 0.8,
    numCtx,
    // Off by default: in side-by-side tests, reasoning made drafts 2–3x slower
    // without fewer invented facts or better readability. WRITER_THINK=true to enable.
    think: process.env.WRITER_THINK === "true",
  });
}

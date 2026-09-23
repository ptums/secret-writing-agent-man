"use client";

import { useEffect, useRef, useState } from "react";
import type { ChatEntry } from "@/lib/types";

export function ChatPanel(props: {
  messages: ChatEntry[];
  pending: boolean;
  onSend: (message: string) => void;
  onOpenDocument: (id: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [props.messages.length, props.pending]);

  function submit(e?: React.FormEvent) {
    e?.preventDefault();
    const text = draft.trim();
    if (!text || props.pending) return;
    props.onSend(text);
    setDraft("");
  }

  return (
    <aside className="flex min-h-0 flex-col border-l border-line bg-panel">
      <div className="border-b border-line p-4">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted">Assistant</h2>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        {props.messages.length === 0 && (
          <p className="text-sm text-muted">
            Try: “Write a launch email for our spring sale” or “Find the blog post about onboarding.”
          </p>
        )}
        {props.messages.map((m) => (
          <div key={m.id} className={m.role === "user" ? "flex justify-end" : ""}>
            <div
              className={`max-w-[90%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm ${
                m.role === "user" ? "bg-accent text-white" : "bg-background border border-line"
              }`}
            >
              {m.content}
              {m.role === "assistant" && m.documentId && (
                <button
                  onClick={() => props.onOpenDocument(m.documentId!)}
                  className="mt-1.5 block text-xs font-medium text-accent hover:underline"
                >
                  Open document →
                </button>
              )}
            </div>
          </div>
        ))}
        {props.pending && <div className="animate-pulse text-sm text-muted">Working… (long pieces can take a minute)</div>}
        <div ref={endRef} />
      </div>
      <form onSubmit={submit} className="border-t border-line p-3">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          rows={3}
          placeholder="Ask for content, revisions, or past work…"
          className="w-full resize-none rounded-md border border-line bg-background px-3 py-2 text-sm outline-none focus:border-accent"
        />
        <button
          type="submit"
          disabled={props.pending || !draft.trim()}
          className="mt-2 w-full rounded-md bg-accent py-2 text-sm font-medium text-white disabled:opacity-40"
        >
          Send
        </button>
      </form>
    </aside>
  );
}

"use client";

import { useEffect, useRef, useState } from "react";
import type { ChatEntry } from "@/lib/types";

const COLLAPSE_AT = 400;

// Pasted PRDs and notes would otherwise fill the whole chat column.
function MessageText({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  if (text.length <= COLLAPSE_AT) return <>{text}</>;
  return (
    <>
      {expanded ? text : `${text.slice(0, COLLAPSE_AT).trimEnd()}…`}
      <button onClick={() => setExpanded(!expanded)} className="mt-1 block text-xs font-medium underline opacity-80">
        {expanded ? "Show less" : `Show all (${text.split(/\s+/).length} words)`}
      </button>
    </>
  );
}

export function ChatPanel(props: {
  threadId: string | null;
  threadTitle: string | null;
  messages: ChatEntry[];
  pending: boolean;
  // Bumped to move focus to the input (e.g. after creating a new document).
  focusKey: number;
  onSend: (message: string) => void;
  onOpenDocument: (id: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (props.focusKey) inputRef.current?.focus();
  }, [props.focusKey]);

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
        <p className="mt-1 truncate text-xs text-muted">
          {props.threadTitle ? <>Chatting about “{props.threadTitle}”</> : "No document open"}
        </p>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        {props.messages.length === 0 && (
          <p className="text-sm text-muted">
            {props.threadTitle
              ? "Paste a PRD or a Google Doc link, and say what to write from it (e.g. “write the homepage copy”)."
              : "Type below to start a new document, or press + in the sidebar."}
          </p>
        )}
        {props.messages.map((m) =>
          m.role === "event" ? (
            <p key={m.id} className="px-1 text-center text-xs text-muted">
              {m.content}
            </p>
          ) : (
            <div key={m.id} className={m.role === "user" ? "flex justify-end" : ""}>
              <div
                className={`max-w-[90%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm ${
                  m.role === "user" ? "bg-accent text-white" : "bg-background border border-line"
                }`}
              >
                <MessageText text={m.content} />
                {m.role === "assistant" && m.documentId && m.documentId !== props.threadId && (
                  <button
                    onClick={() => props.onOpenDocument(m.documentId!)}
                    className="mt-1.5 block text-xs font-medium text-accent hover:underline"
                  >
                    Open document →
                  </button>
                )}
              </div>
            </div>
          ),
        )}
        {props.pending && (
          <div className="animate-pulse text-sm text-muted">Working… (long pieces can take a minute)</div>
        )}
        <div ref={endRef} />
      </div>
      <form onSubmit={submit} className="border-t border-line p-3">
        <textarea
          ref={inputRef}
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

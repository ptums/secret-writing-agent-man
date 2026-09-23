"use client";

import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { DocumentDetail } from "@/lib/types";

export function DocumentReader({ document, loading }: { document: DocumentDetail | null; loading: boolean }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    if (!document) return;
    await navigator.clipboard.writeText(document.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  if (!document) {
    return (
      <main className="flex min-h-0 items-center justify-center p-8 text-center text-muted">
        {loading ? "Loading…" : "Select a document, or ask the assistant to write something."}
      </main>
    );
  }

  return (
    <main className="flex min-h-0 flex-col">
      <div className="flex items-center justify-between gap-4 border-b border-line px-6 py-3">
        <div className="min-w-0">
          <h1 className="truncate text-sm font-semibold">{document.title}</h1>
          <p className="text-xs text-muted">
            Updated {new Date(document.updatedAt).toLocaleString()} · {document.content.split(/\s+/).length} words
          </p>
        </div>
        <button onClick={copy} className="shrink-0 rounded-md border border-line px-2.5 py-1 text-xs text-muted hover:bg-hover">
          {copied ? "Copied" : "Copy Markdown"}
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <article className="prose prose-lg mx-auto max-w-[68ch] px-6 py-12 font-serif dark:prose-invert prose-headings:font-sans prose-headings:tracking-tight">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{document.content}</ReactMarkdown>
        </article>
      </div>
    </main>
  );
}

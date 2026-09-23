"use client";

import { useCallback, useEffect, useState } from "react";
import { ChatPanel } from "@/components/ChatPanel";
import { DocumentHistory } from "@/components/DocumentHistory";
import { DocumentReader } from "@/components/DocumentReader";
import type { ChatEntry, DocumentDetail, DocumentSummary } from "@/lib/types";

export default function Home() {
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState<DocumentDetail | null>(null);
  const [loadingDoc, setLoadingDoc] = useState(false);
  const [messages, setMessages] = useState<ChatEntry[]>([]);
  const [pending, setPending] = useState(false);

  const refreshDocuments = useCallback(async (q: string) => {
    const res = await fetch(`/api/documents${q ? `?q=${encodeURIComponent(q)}` : ""}`);
    if (res.ok) setDocuments(await res.json());
  }, []);

  const openDocument = useCallback(async (id: string) => {
    setLoadingDoc(true);
    const res = await fetch(`/api/documents/${id}`);
    if (res.ok) setActive(await res.json());
    setLoadingDoc(false);
  }, []);

  useEffect(() => {
    const t = setTimeout(() => refreshDocuments(query), 200);
    return () => clearTimeout(t);
  }, [query, refreshDocuments]);

  useEffect(() => {
    fetch("/api/chat")
      .then((r) => r.json())
      .then(setMessages)
      .catch(() => {});
  }, []);

  async function send(message: string) {
    setMessages((m) => [...m, { id: crypto.randomUUID(), role: "user", content: message, documentId: null }]);
    setPending(true);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, activeDocumentId: active?.id ?? null }),
      });
      const { reply, documentId } = (await res.json()) as { reply: string; documentId: string | null };
      setMessages((m) => [...m, { id: crypto.randomUUID(), role: "assistant", content: reply, documentId }]);
      if (documentId) {
        await openDocument(documentId);
        await refreshDocuments(query);
      }
    } catch {
      setMessages((m) => [
        ...m,
        { id: crypto.randomUUID(), role: "assistant", content: "Could not reach the server.", documentId: null },
      ]);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="grid h-dvh grid-cols-[1fr_2fr_1fr]">
      <DocumentHistory
        documents={documents}
        activeId={active?.id ?? null}
        query={query}
        onQueryChange={setQuery}
        onSelect={openDocument}
      />
      <DocumentReader document={active} loading={loadingDoc} />
      <ChatPanel messages={messages} pending={pending} onSend={send} onOpenDocument={openDocument} />
    </div>
  );
}

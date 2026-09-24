"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChatPanel } from "@/components/ChatPanel";
import { DocumentHistory } from "@/components/DocumentHistory";
import { DocumentReader } from "@/components/DocumentReader";
import type { ChatEntry, DocumentDetail, DocumentSummary } from "@/lib/types";

export default function Home() {
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState<DocumentDetail | null>(null);
  const [loadingDoc, setLoadingDoc] = useState(false);
  // Messages are stored with the thread they belong to, so a stale thread never renders.
  const [chat, setChat] = useState<{
    threadId: string | null;
    messages: ChatEntry[];
  }>({
    threadId: null,
    messages: [],
  });
  const [pending, setPending] = useState(false);
  const [focusChat, setFocusChat] = useState(0);
  // Lines the last change added, flashed in the reader.
  const [highlight, setHighlight] = useState<{ docId: string; texts: string[] } | null>(null);
  // The open document is also the chat thread. Mirrored in a ref so a late reply
  // can tell whether the user has since moved to another thread.
  const threadId = active?.id ?? null;
  const messages = chat.threadId === threadId ? chat.messages : [];
  const threadRef = useRef(threadId);
  useEffect(() => {
    threadRef.current = threadId;
  }, [threadId]);
  const dirtyRef = useRef(false);
  const setDirty = useCallback((dirty: boolean) => {
    dirtyRef.current = dirty;
  }, []);

  const openDocument = useCallback(async (id: string, { force = false } = {}) => {
    if (!force && dirtyRef.current && !window.confirm("You have unsaved edits. Discard them?")) return;
    setLoadingDoc(true);
    const res = await fetch(`/api/documents/${id}`);
    if (res.ok) setActive(await res.json());
    setLoadingDoc(false);
  }, []);

  // Every chat belongs to a document, so on first load pick up where the user left off.
  const initialOpenDone = useRef(false);
  const refreshDocuments = useCallback(
    async (q: string) => {
      const res = await fetch(`/api/documents${q ? `?q=${encodeURIComponent(q)}` : ""}`);
      if (!res.ok) return;
      const docs: DocumentSummary[] = await res.json();
      setDocuments(docs);
      if (!initialOpenDone.current && !q) {
        initialOpenDone.current = true;
        if (docs[0]) await openDocument(docs[0].id);
      }
    },
    [openDocument],
  );

  useEffect(() => {
    const t = setTimeout(() => refreshDocuments(query), 200);
    return () => clearTimeout(t);
  }, [query, refreshDocuments]);

  // Warn before closing the tab with unsaved edits.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (dirtyRef.current) e.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  // "Use" on one of the editor's other wordings for a line: swapped in exactly, instantly.
  async function useOption(eventId: string, choice: string) {
    const res = await fetch("/api/chat/options", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ eventId, choice }),
    });
    const data = await res.json();
    if (!res.ok) {
      setChat((c) => ({
        ...c,
        messages: [...c.messages, { id: crypto.randomUUID(), role: "event", content: data.error, documentId: null }],
      }));
      return;
    }
    const { document, change, optionsEvent, highlights } = data as {
      document: DocumentDetail;
      change: ChatEntry;
      optionsEvent: ChatEntry;
      highlights: string[];
    };
    setChat((c) => ({
      ...c,
      messages: [...c.messages.map((m) => (m.id === optionsEvent.id ? optionsEvent : m)), change],
    }));
    setActive(document);
    setHighlight({ docId: document.id, texts: highlights });
    await refreshDocuments(query);
  }

  async function saveDocument(id: string, title: string, content: string) {
    const res = await fetch(`/api/documents/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, content }),
    });
    if (!res.ok) throw new Error("Save failed");
    setActive(await res.json());
    await refreshDocuments(query);
  }

  // Load the conversation for whichever document (thread) is open.
  useEffect(() => {
    if (!threadId) return;
    let cancelled = false;
    fetch(`/api/chat?threadId=${threadId}`)
      .then((r) => r.json())
      // Don't clobber a thread that's already live locally (e.g. a new document whose
      // first message was appended before this fetch returned).
      .then(
        (rows: ChatEntry[]) =>
          !cancelled && setChat((c) => (c.threadId === threadId ? c : { threadId, messages: rows })),
      )
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [threadId]);

  async function newDocument(): Promise<DocumentDetail | null> {
    if (dirtyRef.current && !window.confirm("You have unsaved edits. Discard them?")) return null;
    const res = await fetch("/api/documents", { method: "POST" });
    if (!res.ok) return null;
    const doc: DocumentDetail = await res.json();
    setChat({ threadId: doc.id, messages: [] }); // a new thread is empty; no need to wait for the fetch
    setActive(doc);
    setFocusChat((n) => n + 1);
    await refreshDocuments(query);
    return doc;
  }

  async function send(message: string) {
    // Typing with no document open starts a new one: every chat belongs to a document.
    const sentFrom = threadId ?? (await newDocument())?.id;
    if (!sentFrom) return;
    // The reply is saved server-side either way; it only shows if that thread is still loaded.
    const append = (entry: Omit<ChatEntry, "id">) =>
      setChat((c) =>
        c.threadId === sentFrom
          ? {
              ...c,
              messages: [...c.messages, { id: crypto.randomUUID(), ...entry }],
            }
          : c,
      );
    append({ role: "user", content: message, documentId: null });
    setHighlight(null);
    setPending(true);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, activeDocumentId: sentFrom }),
      });
      const { reply, documentId, events, highlights } = (await res.json()) as {
        reply: string;
        documentId: string | null;
        events?: ChatEntry[];
        highlights?: string[];
      };
      // Saved events keep their real ids: "Use" on an option needs them.
      for (const e of events ?? [])
        setChat((c) => (c.threadId === sentFrom ? { ...c, messages: [...c.messages, e] } : c));
      append({ role: "assistant", content: reply, documentId });
      if (documentId && threadRef.current === sentFrom) {
        await openDocument(documentId);
        // After the new version is showing, so the flash lands on the changed text.
        if (highlights?.length) setHighlight({ docId: documentId, texts: highlights });
      }
      if (documentId) await refreshDocuments(query);
    } catch {
      append({
        role: "assistant",
        content: "Could not reach the server.",
        documentId: null,
      });
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
        onNew={newDocument}
      />
      <DocumentReader
        document={active}
        loading={loadingDoc}
        highlights={highlight && highlight.docId === active?.id ? highlight.texts : []}
        onSave={saveDocument}
        onDirtyChange={setDirty}
      />
      <ChatPanel
        threadId={threadId}
        threadTitle={active?.title ?? null}
        messages={messages}
        pending={pending}
        focusKey={focusChat}
        onSend={send}
        onOpenDocument={openDocument}
        onUseOption={useOption}
      />
    </div>
  );
}

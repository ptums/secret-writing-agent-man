"use client";

import {
  createElement,
  isValidElement,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { normalizeText } from "@/lib/textEdit";
import type { DocumentDetail } from "@/lib/types";

const toolbarButton =
  "shrink-0 rounded-md border border-line px-2.5 py-1 text-xs text-muted hover:bg-hover disabled:opacity-40";

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement(node)) return textOf((node.props as { children?: ReactNode }).children);
  return "";
}

const MIN_MATCH = 6;
const HIGHLIGHT_TAGS = ["p", "li", "h1", "h2", "h3", "h4", "blockquote"] as const;

// Markdown renderers that flash any block whose text matches a line the last change added.
function highlightComponents(highlights: string[]): Components | undefined {
  const wanted = highlights.map(normalizeText).filter((h) => h.length >= MIN_MATCH);
  if (!wanted.length) return undefined;
  const matches = (children: ReactNode) => {
    const text = normalizeText(textOf(children));
    return text.length >= MIN_MATCH && wanted.some((h) => text.includes(h) || h.includes(text));
  };
  return Object.fromEntries(
    HIGHLIGHT_TAGS.map((tag) => {
      const Block = ({ node, className, ...props }: ComponentPropsWithoutRef<"p"> & { node?: unknown }) => {
        void node; // react-markdown's AST node; not a DOM attribute
        return createElement(tag, {
          ...props,
          className: matches(props.children) ? `${className ?? ""} flash-change` : className,
        });
      };
      Block.displayName = `Highlight(${tag})`;
      return [tag, Block];
    }),
  ) as Components;
}

export function DocumentReader(props: {
  document: DocumentDetail | null;
  loading: boolean;
  highlights: string[];
  onSave: (id: string, title: string, content: string) => Promise<void>;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const { document, loading } = props;

  if (!document) {
    return (
      <main className="flex min-h-0 items-center justify-center p-8 text-center text-muted">
        {loading ? "Loading…" : "Select a document, or ask the assistant to write something."}
      </main>
    );
  }

  // Keyed by id + updatedAt so opening another document, or an agent revision, resets edit state.
  return <DocumentView key={`${document.id}:${document.updatedAt}`} {...props} document={document} />;
}

function DocumentView({
  document,
  highlights,
  onSave,
  onDirtyChange,
}: {
  document: DocumentDetail;
  highlights: string[];
  onSave: (id: string, title: string, content: string) => Promise<void>;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(document.title);
  const [content, setContent] = useState(document.content);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const articleRef = useRef<HTMLElement>(null);
  const components = useMemo(() => highlightComponents(highlights), [highlights]);

  // This view remounts on every new version, so the flash plays once per change.
  useEffect(() => {
    articleRef.current?.querySelector(".flash-change")?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [components]);

  const dirty = editing && (title !== document.title || content !== document.content);
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  async function copy() {
    await navigator.clipboard.writeText(document.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  async function save() {
    if (!dirty || saving) return setEditing(false);
    if (!title.trim() || !content.trim()) return setError("Title and content can't be empty.");
    setSaving(true);
    setError(null);
    try {
      // On success the parent reloads the document, which remounts this view in read mode.
      await onSave(document.id, title.trim(), content);
    } catch {
      setError("Couldn't save. Try again.");
      setSaving(false);
    }
  }

  function cancel() {
    if (dirty && !window.confirm("Discard your changes?")) return;
    setTitle(document.title);
    setContent(document.content);
    setError(null);
    setEditing(false);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key === "s") {
      e.preventDefault();
      save();
    } else if (e.key === "Escape") {
      cancel();
    }
  }

  const words = (editing ? content : document.content).split(/\s+/).filter(Boolean).length;

  return (
    <main className="flex min-h-0 flex-col" onKeyDown={editing ? onKeyDown : undefined}>
      <div className="flex items-center justify-between gap-4 border-b border-line px-6 py-3">
        <div className="min-w-0 flex-1">
          {editing ? (
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              aria-label="Document title"
              className="w-full rounded border border-line bg-background px-2 py-0.5 text-sm font-semibold outline-none focus:border-accent"
            />
          ) : (
            <h1 className="truncate text-sm font-semibold">{document.title}</h1>
          )}
          <p className="text-xs text-muted">
            {error ? (
              <span className="text-red-600">{error}</span>
            ) : editing ? (
              <>
                {dirty ? "Unsaved changes" : "Editing"} · {words} words · ⌘S to save, Esc to cancel
              </>
            ) : (
              <>
                Updated {new Date(document.updatedAt).toLocaleString()} · {words} words
              </>
            )}
          </p>
        </div>
        {editing ? (
          <div className="flex gap-2">
            <button onClick={cancel} disabled={saving} className={toolbarButton}>
              Cancel
            </button>
            <button
              onClick={save}
              disabled={saving || !dirty}
              className="shrink-0 rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-white disabled:opacity-40"
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        ) : (
          <div className="flex gap-2">
            {document.content.trim() && (
              <button onClick={copy} className={toolbarButton}>
                {copied ? "Copied" : "Copy Markdown"}
              </button>
            )}
            <button onClick={() => setEditing(true)} className={toolbarButton}>
              Edit
            </button>
          </div>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {!editing && !document.content.trim() ? (
          <div className="mx-auto max-w-[52ch] px-6 py-24 text-center text-muted">
            <p className="font-serif text-2xl text-foreground">A blank page.</p>
            <p className="mt-3 text-sm">
              Paste a PRD or notes into the chat and say what you need. The draft will appear here. Or click Edit to
              write it yourself.
            </p>
          </div>
        ) : editing ? (
          <div className="mx-auto flex h-full max-w-[68ch] flex-col px-6 py-8">
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              autoFocus
              spellCheck
              aria-label="Document content (Markdown)"
              className="min-h-[60vh] flex-1 resize-none bg-transparent font-mono text-[15px] leading-7 outline-none"
            />
          </div>
        ) : (
          <article
            ref={articleRef}
            className="prose prose-lg mx-auto max-w-[68ch] px-6 py-12 font-serif dark:prose-invert prose-headings:font-sans prose-headings:tracking-tight"
          >
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
              {document.content}
            </ReactMarkdown>
          </article>
        )}
      </div>
    </main>
  );
}

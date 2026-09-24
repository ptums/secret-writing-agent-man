"use client";

import type { DocumentSummary } from "@/lib/types";

const LABELS: Record<string, string> = {
  blog_post: "Blog post",
  landing_page: "Landing page",
  website_copy: "Website",
  email: "Email",
  ad_copy: "Ad copy",
  social_post: "Social",
  campaign_brief: "Campaign brief",
  other: "Other",
};

export function DocumentHistory(props: {
  documents: DocumentSummary[];
  activeId: string | null;
  query: string;
  onQueryChange: (q: string) => void;
  onSelect: (id: string) => void;
  onNew: () => void;
}) {
  return (
    <aside className="flex min-h-0 flex-col border-r border-line bg-panel">
      <div className="border-b border-line p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted">Documents</h2>
          <button
            onClick={props.onNew}
            aria-label="New document"
            title="New document"
            className="flex h-7 w-7 items-center justify-center rounded-md border border-line text-lg leading-none text-muted hover:bg-hover hover:text-foreground"
          >
            +
          </button>
        </div>
        <input
          type="search"
          value={props.query}
          onChange={(e) => props.onQueryChange(e.target.value)}
          placeholder="Search documents…"
          className="w-full rounded-md border border-line bg-background px-3 py-2 text-sm outline-none focus:border-accent"
        />
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto p-2">
        {props.documents.length === 0 && (
          <li className="p-3 text-sm text-muted">
            {props.query ? "No matches." : "No documents yet. Press + to start one."}
          </li>
        )}
        {props.documents.map((doc) => (
          <li key={doc.id}>
            <button
              onClick={() => props.onSelect(doc.id)}
              className={`w-full rounded-md px-3 py-2.5 text-left transition-colors hover:bg-hover ${
                doc.id === props.activeId ? "bg-hover" : ""
              }`}
            >
              <div className="line-clamp-2 text-sm font-medium">{doc.title}</div>
              <div className="mt-1 text-xs text-muted">
                {LABELS[doc.contentType] ?? doc.contentType} · {new Date(doc.updatedAt).toLocaleDateString()}
              </div>
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}

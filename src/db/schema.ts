import { pgTable, text, timestamp, uuid, index } from "drizzle-orm/pg-core";

export const CONTENT_TYPES = [
  "blog_post",
  "landing_page",
  "website_copy",
  "email",
  "ad_copy",
  "social_post",
  "campaign_brief",
  "other",
] as const;
export type ContentType = (typeof CONTENT_TYPES)[number];

export const documents = pgTable(
  "documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    title: text("title").notNull(),
    contentType: text("content_type").$type<ContentType>().notNull(),
    // The request the writer agent was given, kept so revisions stay on-brief.
    brief: text("brief").notNull(),
    content: text("content").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("documents_updated_at_idx").on(t.updatedAt)],
);

// Snapshot of a document's content taken before each revision overwrites it.
export const documentRevisions = pgTable("document_revisions", {
  id: uuid("id").primaryKey().defaultRandom(),
  documentId: uuid("document_id")
    .notNull()
    .references(() => documents.id, { onDelete: "cascade" }),
  content: text("content").notNull(),
  instructions: text("instructions"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const chatMessages = pgTable("chat_messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  role: text("role").$type<"user" | "assistant">().notNull(),
  content: text("content").notNull(),
  // Document the message produced or referred to, so the UI can link to it.
  documentId: uuid("document_id").references(() => documents.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export type Document = typeof documents.$inferSelect;
export type ChatMessage = typeof chatMessages.$inferSelect;

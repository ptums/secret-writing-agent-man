import { desc, eq, sql } from "drizzle-orm";
import { db } from ".";
import { chatMessages, documentRevisions, documents, type ChatRole, type ContentType } from "./schema";

const summaryColumns = {
  id: documents.id,
  title: documents.title,
  contentType: documents.contentType,
  updatedAt: documents.updatedAt,
};

export function listDocuments(limit = 50) {
  return db.select(summaryColumns).from(documents).orderBy(desc(documents.updatedAt)).limit(limit);
}

// Postgres full-text search over title + brief + content, with a substring fallback
// so short or partial queries ("Q3", "acme") still match.
export function searchDocuments(query: string, limit = 10) {
  const vector = sql`to_tsvector('english', ${documents.title} || ' ' || ${documents.brief} || ' ' || ${documents.content})`;
  const tsQuery = sql`websearch_to_tsquery('english', ${query})`;
  const like = `%${query}%`;
  return db
    .select(summaryColumns)
    .from(documents)
    .where(sql`${vector} @@ ${tsQuery} or ${documents.title} ilike ${like} or ${documents.brief} ilike ${like}`)
    .orderBy(sql`ts_rank(${vector}, ${tsQuery}) desc`, desc(documents.updatedAt))
    .limit(limit);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function getDocument(id: string) {
  // Agents sometimes pass made-up ids; Postgres would throw on a non-uuid.
  if (!UUID.test(id)) return null;
  const [doc] = await db.select().from(documents).where(eq(documents.id, id));
  return doc ?? null;
}

export async function createDocument(input: {
  title: string;
  contentType: ContentType;
  brief: string;
  sourceMaterial: string | null;
  content: string;
}) {
  const [doc] = await db.insert(documents).values(input).returning();
  return doc;
}

export const UNTITLED = "Untitled document";

// Created by the "+" button; the first create_content in its thread fills it in.
export async function createBlankDocument() {
  const [doc] = await db
    .insert(documents)
    .values({ title: UNTITLED, contentType: "other", brief: "", content: "" })
    .returning();
  return doc;
}

export function isBlank(doc: { content: string }) {
  return doc.content.trim() === "";
}

// Writes the first draft into a blank document. No revision snapshot: there's nothing to keep.
export async function fillDocument(
  id: string,
  input: { title: string; contentType: ContentType; brief: string; sourceMaterial: string | null; content: string },
) {
  const [doc] = await db
    .update(documents)
    .set({ ...input, updatedAt: new Date() })
    .where(eq(documents.id, id))
    .returning();
  return doc;
}

export async function renameDocument(id: string, title: string) {
  const [doc] = await db.update(documents).set({ title }).where(eq(documents.id, id)).returning();
  return doc ?? null;
}

// Doesn't bump updatedAt: attaching sources isn't an edit to the copy.
export async function setSourceMaterial(id: string, sourceMaterial: string) {
  const [doc] = await db.update(documents).set({ sourceMaterial }).where(eq(documents.id, id)).returning();
  return doc;
}

// Snapshots the current content into document_revisions, then applies the update.
// Used for both agent revisions and manual edits.
export async function reviseDocument(id: string, update: { content: string; title?: string }, instructions: string) {
  return db.transaction(async (tx) => {
    const [current] = await tx.select().from(documents).where(eq(documents.id, id));
    if (!current) return null;
    await tx.insert(documentRevisions).values({ documentId: id, content: current.content, instructions });
    const [doc] = await tx
      .update(documents)
      .set({ ...update, updatedAt: new Date() })
      .where(eq(documents.id, id))
      .returning();
    return doc;
  });
}

export async function recentChatMessages(threadId: string, limit = 20) {
  const rows = await db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.threadId, threadId))
    .orderBy(desc(chatMessages.createdAt))
    .limit(limit);
  return rows.reverse();
}

export function saveChatMessage(
  threadId: string,
  role: ChatRole,
  content: string,
  documentId?: string | null,
) {
  return db.insert(chatMessages).values({ threadId, role, content, documentId: documentId ?? null });
}

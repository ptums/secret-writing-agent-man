import type { ChatMessage, Document } from "@/db/schema";

// Shapes as they arrive over JSON (dates become strings).
type Serialized<T> = { [K in keyof T]: T[K] extends Date ? string : T[K] };

export type DocumentSummary = Serialized<Pick<Document, "id" | "title" | "contentType" | "updatedAt">>;
export type DocumentDetail = Serialized<Document>;
export type ChatEntry = Pick<Serialized<ChatMessage>, "role" | "content" | "documentId"> & { id: string };

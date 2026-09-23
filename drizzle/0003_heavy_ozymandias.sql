-- Every chat now belongs to a document. Messages from the old general thread move to the
-- document they link to; anything left without a home makes SET NOT NULL fail loudly
-- rather than being deleted.
UPDATE "chat_messages" SET "thread_id" = "document_id" WHERE "thread_id" IS NULL AND "document_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_messages" ALTER COLUMN "thread_id" SET NOT NULL;

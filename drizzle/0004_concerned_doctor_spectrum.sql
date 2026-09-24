ALTER TABLE "document_revisions" ADD COLUMN "kind" text DEFAULT 'revise' NOT NULL;--> statement-breakpoint
ALTER TABLE "document_revisions" ADD COLUMN "find" text;--> statement-breakpoint
ALTER TABLE "document_revisions" ADD COLUMN "replace" text;--> statement-breakpoint
UPDATE "document_revisions" SET "kind" = 'manual' WHERE "instructions" = 'Manual edit';

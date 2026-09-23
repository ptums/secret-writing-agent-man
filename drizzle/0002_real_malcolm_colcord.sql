ALTER TABLE "chat_messages" ADD COLUMN "thread_id" uuid;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_thread_id_documents_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_messages_thread_idx" ON "chat_messages" USING btree ("thread_id","created_at");
import { listDocuments, searchDocuments } from "@/db/queries";

export async function GET(request: Request) {
  const q = new URL(request.url).searchParams.get("q")?.trim();
  const docs = q ? await searchDocuments(q, 50) : await listDocuments();
  return Response.json(docs);
}

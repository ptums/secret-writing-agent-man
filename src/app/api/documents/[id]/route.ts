import { z } from "zod";
import { getDocument, reviseDocument } from "@/db/queries";

export async function GET(_request: Request, ctx: RouteContext<"/api/documents/[id]">) {
  const { id } = await ctx.params;
  const doc = await getDocument(id);
  if (!doc) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json(doc);
}

const ManualEdit = z.object({
  title: z.string().trim().min(1),
  content: z.string().trim().min(1),
});

export async function PATCH(request: Request, ctx: RouteContext<"/api/documents/[id]">) {
  const { id } = await ctx.params;
  const parsed = ManualEdit.safeParse(await request.json());
  if (!parsed.success) return Response.json({ error: "Title and content are required" }, { status: 400 });
  if (!(await getDocument(id))) return Response.json({ error: "Not found" }, { status: 404 });

  const doc = await reviseDocument(id, parsed.data, "Manual edit");
  return Response.json(doc);
}

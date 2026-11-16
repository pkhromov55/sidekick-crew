// Shared record helpers used by the agent tools and by passive extraction.
import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import { db, schema } from "@/db";

export type RecordInput = {
  id?: string | null; // full id or 8-char prefix
  kind: string;
  title: string;
  fields?: Record<string, unknown> | null;
  status?: string | null;
  ownerPersonId?: string | null;
  sourceTgMessageId?: number | null;
};

function clean(fields?: Record<string, unknown> | null) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields ?? {})) {
    if (v === undefined || v === null || v === "") continue;
    out[k] = v;
  }
  return out;
}

// Update by id prefix, else merge into an existing record with the same kind+title, else insert.
export async function upsertRecord(spaceId: string, r: RecordInput) {
  const fields = clean(r.fields);
  let existing: typeof schema.records.$inferSelect | undefined;
  if (r.id) {
    existing = (
      await db
        .select()
        .from(schema.records)
        .where(and(eq(schema.records.spaceId, spaceId), sql`${schema.records.id}::text like ${r.id + "%"}`))
        .limit(1)
    )[0];
  }
  if (!existing) {
    existing = (
      await db
        .select()
        .from(schema.records)
        .where(
          and(eq(schema.records.spaceId, spaceId), eq(schema.records.kind, r.kind), ilike(schema.records.title, r.title)),
        )
        .limit(1)
    )[0];
  }
  if (existing) {
    const [row] = await db
      .update(schema.records)
      .set({
        title: r.title || existing.title,
        data: { ...existing.data, ...fields },
        status: r.status ?? existing.status,
        ownerPersonId: r.ownerPersonId ?? existing.ownerPersonId,
        updatedAt: new Date(),
      })
      .where(eq(schema.records.id, existing.id))
      .returning();
    return { row, created: false };
  }
  const [row] = await db
    .insert(schema.records)
    .values({
      spaceId,
      kind: r.kind,
      title: r.title,
      data: fields,
      status: r.status ?? "active",
      ownerPersonId: r.ownerPersonId ?? null,
      sourceTgMessageId: r.sourceTgMessageId ?? null,
    })
    .returning();
  return { row, created: true };
}

export async function listRecords(spaceId: string, opts: { kind?: string; status?: string; query?: string; limit?: number }) {
  const conds = [eq(schema.records.spaceId, spaceId)];
  if (opts.kind) conds.push(eq(schema.records.kind, opts.kind));
  if (opts.status && opts.status !== "all") conds.push(eq(schema.records.status, opts.status));
  if (opts.query) {
    const q = `%${opts.query}%`;
    conds.push(or(ilike(schema.records.title, q), sql`${schema.records.data}::text ilike ${q}`)!);
  }
  return db
    .select()
    .from(schema.records)
    .where(and(...conds))
    .orderBy(desc(schema.records.updatedAt))
    .limit(opts.limit ?? 50);
}

export function formatRecord(r: typeof schema.records.$inferSelect) {
  const d = r.data as Record<string, unknown>;
  const parts = Object.entries(d)
    .filter(([k]) => k !== "notes")
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(", ");
  const notes = d.notes ? ` · ${String(d.notes)}` : "";
  return `[${r.id.slice(0, 8)}] (${r.kind}) ${r.title}${parts ? ` — ${parts}` : ""}${notes}${r.status !== "active" ? ` [${r.status}]` : ""}`;
}

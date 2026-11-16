import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { formatRecord } from "./records";
import { getTemplate } from "./templates";
import { getBot } from "./bots";

type Space = typeof schema.spaces.$inferSelect;

export function personLabel(p: { username: string | null; firstName: string | null; lastName: string | null } | null | undefined) {
  if (!p) return "unknown";
  const name = [p.firstName, p.lastName].filter(Boolean).join(" ");
  return p.username ? `${name || p.username} (@${p.username})` : name || "unknown";
}

function fmtTime(d: Date, tz: string) {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: tz,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

// Everything the agent should know about this space, rendered as text.
// Order matters for prompt caching: stable things first, volatile last.
export async function buildSpaceContext(space: Space, recentLimit = 40) {
  const [members, openTasks, mems, recent, recs] = await Promise.all([
    db
      .select({ role: schema.spaceMembers.role, notes: schema.spaceMembers.notes, p: schema.people })
      .from(schema.spaceMembers)
      .innerJoin(schema.people, eq(schema.people.id, schema.spaceMembers.personId))
      .where(eq(schema.spaceMembers.spaceId, space.id)),
    db
      .select({ t: schema.tasks, p: schema.people })
      .from(schema.tasks)
      .leftJoin(schema.people, eq(schema.people.id, schema.tasks.assigneePersonId))
      .where(and(eq(schema.tasks.spaceId, space.id), eq(schema.tasks.status, "open")))
      .orderBy(schema.tasks.dueAt),
    db
      .select()
      .from(schema.memories)
      .where(
        and(
          or(eq(schema.memories.spaceId, space.id), isNull(schema.memories.spaceId)),
          or(isNull(schema.memories.expiresAt), sql`${schema.memories.expiresAt} > now()`),
        ),
      )
      .orderBy(desc(schema.memories.createdAt))
      .limit(60),
    db
      .select({ m: schema.messages, p: schema.people })
      .from(schema.messages)
      .leftJoin(schema.people, eq(schema.people.id, schema.messages.personId))
      .where(eq(schema.messages.spaceId, space.id))
      .orderBy(desc(schema.messages.sentAt))
      .limit(recentLimit),
    db
      .select()
      .from(schema.records)
      .where(and(eq(schema.records.spaceId, space.id), eq(schema.records.status, "active")))
      .orderBy(desc(schema.records.updatedAt))
      .limit(80),
  ]);

  const tz = space.timezone;
  const botName = getBot(space.botId).name;
  const lines: string[] = [];
  lines.push(`# Space: ${space.title ?? space.tgChatId}`);
  lines.push(`Тип: ${space.kind}. Таймзона: ${tz}.`);
  const tpl = space.template.template ? getTemplate(space.template.template) : undefined;
  if (tpl) lines.push(`\nШаблон: ${tpl.id}.\n${tpl.persona}`);
  if (space.template.persona) lines.push(`\nИнструкции для этого space:\n${space.template.persona}`);
  if (space.summary) lines.push(`\n## Сводка по чату\n${space.summary}`);

  const topics = Object.entries(space.template.topics ?? {});
  if (topics.length) lines.push(`\nТемы чата: ${topics.map(([id, n]) => `${n} (#${id})`).join(", ")}.`);

  lines.push(`\n## Участники`);
  for (const m of members) lines.push(`- ${personLabel(m.p)} — ${m.role}${m.notes ? `: ${m.notes}` : ""}`);

  lines.push(`\n## Открытые задачи`);
  if (!openTasks.length) lines.push("(нет)");
  for (const { t, p } of openTasks)
    lines.push(
      `- [${t.id.slice(0, 8)}] ${t.title}${p ? ` — ${personLabel(p)}` : ""}${t.dueAt ? ` — до ${fmtTime(t.dueAt, tz)}` : ""}`,
    );

  // Suppression rules go first and loud: they override anything the raw
  // message journal below may still mention.
  const rules = mems.filter((m) => m.kind === "rule");
  const facts = mems.filter((m) => m.kind !== "rule");
  if (rules.length) {
    lines.push(`\n## Правила этого чата (соблюдать строго)`);
    for (const m of rules) lines.push(`- [${m.id.slice(0, 8)}] ${m.content}`);
  }

  if (recs.length) {
    lines.push(`\n## Записи (лиды, контакты, стейкхолдеры)`);
    const byKind = new Map<string, number>();
    for (const r of recs) byKind.set(r.kind, (byKind.get(r.kind) ?? 0) + 1);
    lines.push([...byKind].map(([k, n]) => `${k}: ${n}`).join(", "));
    for (const r of recs) lines.push(`- ${formatRecord(r)}`);
  }

  lines.push(`\n## Память`);
  if (!facts.length) lines.push("(пусто)");
  for (const m of facts) lines.push(`- [${m.id.slice(0, 8)}] (${m.kind}) ${m.content}`);

  lines.push(`\n## Последние сообщения (старые сверху)`);
  for (const { m, p } of recent.reverse()) {
    const who = m.fromBot ? botName : personLabel(p);
    const body = m.text ?? `[${m.kind}${m.fileName ? `: ${m.fileName}` : ""}]`;
    const fwd = forwardLabel(m.meta);
    const th = (m.meta as Record<string, unknown> | null)?.thread_id;
    const topic = th ? (space.template.topics?.[String(th)] ?? `#${th}`) : null;
    lines.push(`[${fmtTime(m.sentAt, tz)}]${topic ? ` [${topic}]` : ""} #${m.tgMessageId} ${who}${fwd ? ` (переслал от ${fwd})` : ""}: ${body}`);
  }
  return lines.join("\n");
}

// Knowledge documents as a separate, rarely-changing block (cached in the system prefix).
export async function buildDocumentsBlock(spaceId: string, maxChars = 200_000) {
  const docs = await db.select().from(schema.documents).where(eq(schema.documents.spaceId, spaceId)).orderBy(schema.documents.createdAt);
  if (!docs.length) return "";
  const out: string[] = ["# Документы этого space"];
  let used = 0;
  for (const d of docs) {
    const budget = maxChars - used;
    if (budget <= 0) {
      out.push(`\n## ${d.title}\n(не поместился в контекст, читай через read_document)`);
      continue;
    }
    const body = d.content.length > budget ? d.content.slice(0, budget) + "\n…(обрезано, остальное через read_document)" : d.content;
    used += body.length;
    out.push(`\n## ${d.title} [${d.id.slice(0, 8)}]\n${body}`);
  }
  return out.join("\n");
}

export function forwardLabel(meta: Record<string, unknown> | null | undefined): string | null {
  const fo = meta?.forward_origin as Record<string, unknown> | undefined;
  if (!fo) return null;
  const t = fo.type as string;
  if (t === "user") {
    const u = fo.sender_user as { first_name?: string; last_name?: string; username?: string };
    const name = [u.first_name, u.last_name].filter(Boolean).join(" ");
    return u.username ? `${name} (@${u.username})` : name || "user";
  }
  if (t === "hidden_user") return String(fo.sender_user_name ?? "hidden user");
  if (t === "chat") return String((fo.sender_chat as { title?: string })?.title ?? "chat");
  if (t === "channel") return String((fo.chat as { title?: string })?.title ?? "channel");
  return null;
}

export function nowInTz(tz: string) {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: tz,
    dateStyle: "full",
    timeStyle: "short",
  }).format(new Date());
}

import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import { db, schema } from "@/db";

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
  const [members, openTasks, mems, recent] = await Promise.all([
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
  ]);

  const tz = space.timezone;
  const lines: string[] = [];
  lines.push(`# Space: ${space.title ?? space.tgChatId}`);
  lines.push(`Тип: ${space.kind}. Таймзона: ${tz}.`);
  if (space.template.persona) lines.push(`\nИнструкции для этого space:\n${space.template.persona}`);
  if (space.summary) lines.push(`\n## Сводка по чату\n${space.summary}`);

  lines.push(`\n## Участники`);
  for (const m of members) lines.push(`- ${personLabel(m.p)} — ${m.role}${m.notes ? `: ${m.notes}` : ""}`);

  lines.push(`\n## Открытые задачи`);
  if (!openTasks.length) lines.push("(нет)");
  for (const { t, p } of openTasks)
    lines.push(
      `- [${t.id.slice(0, 8)}] ${t.title}${p ? ` — ${personLabel(p)}` : ""}${t.dueAt ? ` — до ${fmtTime(t.dueAt, tz)}` : ""}`,
    );

  lines.push(`\n## Память`);
  if (!mems.length) lines.push("(пусто)");
  for (const m of mems) lines.push(`- (${m.kind}) ${m.content}`);

  lines.push(`\n## Последние сообщения (старые сверху)`);
  for (const { m, p } of recent.reverse()) {
    const who = m.fromBot ? "Crew" : personLabel(p);
    const body = m.text ?? `[${m.kind}${m.fileName ? `: ${m.fileName}` : ""}]`;
    lines.push(`[${fmtTime(m.sentAt, tz)}] #${m.tgMessageId} ${who}: ${body}`);
  }
  return lines.join("\n");
}

export function nowInTz(tz: string) {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: tz,
    dateStyle: "full",
    timeStyle: "short",
  }).format(new Date());
}

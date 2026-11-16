import { and, eq, lte, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { getTelegramBot, sendPlain } from "@/lib/telegram";
import { recordBotMessage } from "@/lib/ingest";

function localParts(tz: string, d = new Date()) {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24, minute: Number(p.minute) };
}

function fmtDay(d: Date, tz: string) {
  return new Intl.DateTimeFormat("ru-RU", { timeZone: tz, day: "2-digit", month: "2-digit" }).format(d);
}

// Daily to-do digest for spaces with template.digest set: overdue, today, next 3 days, undated.
async function sendDailyDigests() {
  const spaces = await db.select().from(schema.spaces).where(and(eq(schema.spaces.status, "active"), sql`${schema.spaces.template} ? 'digest'`));
  let sent = 0;
  for (const s of spaces) {
    const dg = s.template.digest;
    if (!dg) continue;
    const now = localParts(s.timezone);
    if (dg.lastSentDate === now.date) continue;
    if (now.hour < dg.hour || (now.hour === dg.hour && now.minute < dg.minute)) continue;
    try {
      const tasks = await db
        .select({ t: schema.tasks, p: schema.people })
        .from(schema.tasks)
        .leftJoin(schema.people, eq(schema.people.id, schema.tasks.assigneePersonId))
        .where(and(eq(schema.tasks.spaceId, s.id), eq(schema.tasks.status, "open")))
        .orderBy(schema.tasks.dueAt);
      const owner = (
        await db
          .select({ p: schema.people })
          .from(schema.spaceMembers)
          .innerJoin(schema.people, eq(schema.people.id, schema.spaceMembers.personId))
          .where(and(eq(schema.spaceMembers.spaceId, s.id), eq(schema.spaceMembers.role, "owner")))
          .limit(1)
      )[0]?.p;
      const tag = owner?.username ? `@${owner.username} ` : "";
      const todayStr = now.date;
      const in3 = new Date(Date.now() + 3 * 86400_000);
      const line = ({ t, p }: (typeof tasks)[number]) =>
        `• ${t.title}${p?.username && p.username !== owner?.username ? ` (@${p.username})` : ""}${t.dueAt ? ` — ${fmtDay(t.dueAt, s.timezone)}` : ""}`;
      const dayOf = (d: Date) => localParts(s.timezone, d).date;
      const overdue = tasks.filter((x) => x.t.dueAt && dayOf(x.t.dueAt) < todayStr);
      const today = tasks.filter((x) => x.t.dueAt && dayOf(x.t.dueAt) === todayStr);
      const soon = tasks.filter((x) => x.t.dueAt && dayOf(x.t.dueAt) > todayStr && x.t.dueAt <= in3);
      const undated = tasks.filter((x) => !x.t.dueAt);
      const parts = [`${tag}план на сегодня, ${fmtDay(new Date(), s.timezone)}:`];
      if (overdue.length) parts.push(`\nПросрочено:\n${overdue.map(line).join("\n")}`);
      parts.push(`\nСегодня:\n${today.length ? today.map(line).join("\n") : "• ничего со сроком на сегодня"}`);
      if (soon.length) parts.push(`\nБлижайшие 3 дня:\n${soon.map(line).join("\n")}`);
      if (undated.length) parts.push(`\nБез срока: ${undated.length} задач${undated.length < 4 ? "и" : ""}. Скажи «покажи задачи без срока», если нужно.`);
      if (!tasks.length) parts.push(`\nОткрытых задач нет. Добавь: «задача: … до пятницы».`);
      const bot = await getTelegramBot(s.botId);
      const msgs = await sendPlain(bot, s.tgChatId, parts.join("\n"), undefined, dg.threadId ?? undefined);
      for (const m of msgs) await recordBotMessage(s.id, m.message_id, m.text ?? "");
      await db
        .update(schema.spaces)
        .set({ template: { ...s.template, digest: { ...dg, lastSentDate: now.date } } })
        .where(eq(schema.spaces.id, s.id));
      sent++;
    } catch (e) {
      console.error("digest failed", s.id, e instanceof Error ? e.message : e);
    }
  }
  return sent;
}

export const maxDuration = 60;

// Fires due reminders. Vercel Cron calls this with Authorization: Bearer $CRON_SECRET.
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("forbidden", { status: 403 });
  }
  const due = await db
    .select({ r: schema.reminders, s: schema.spaces, p: schema.people })
    .from(schema.reminders)
    .innerJoin(schema.spaces, eq(schema.spaces.id, schema.reminders.spaceId))
    .leftJoin(schema.people, eq(schema.people.id, schema.reminders.targetPersonId))
    .where(and(eq(schema.reminders.status, "pending"), lte(schema.reminders.fireAt, new Date())))
    .limit(50);

  let sent = 0;
  for (const { r, s, p } of due) {
    try {
      const bot = await getTelegramBot(s.botId);
      const tag = p?.username ? `@${p.username} ` : "";
      const text = `${tag}⏰ ${r.text}`;
      const m = await bot.api.sendMessage(s.tgChatId, text, { message_thread_id: r.threadId ?? undefined });
      await recordBotMessage(s.id, m.message_id, text);
      await db.update(schema.reminders).set({ status: "sent", sentAt: new Date() }).where(eq(schema.reminders.id, r.id));
      sent++;
    } catch (e) {
      console.error("reminder failed", r.id, e);
    }
  }
  const digests = await sendDailyDigests();
  return Response.json({ due: due.length, sent, digests });
}


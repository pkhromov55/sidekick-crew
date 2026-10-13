import { and, eq, lte } from "drizzle-orm";
import { db, schema } from "@/db";
import { getTelegramBot, sendPlain } from "@/lib/telegram";
import { recordBotMessage } from "@/lib/ingest";

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
      const m = await bot.api.sendMessage(s.tgChatId, text);
      await recordBotMessage(s.id, m.message_id, text);
      await db.update(schema.reminders).set({ status: "sent", sentAt: new Date() }).where(eq(schema.reminders.id, r.id));
      sent++;
    } catch (e) {
      console.error("reminder failed", r.id, e);
    }
  }
  return Response.json({ due: due.length, sent });
}

// keep sendPlain referenced for future digest use
void sendPlain;

import { waitUntil } from "@vercel/functions";
import { InputFile } from "grammy";
import type { Message, Update } from "grammy/types";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { getBot } from "@/lib/bots";
import { getTelegramBot, isAddressedToBot, sendPlain, stripMention } from "@/lib/telegram";
import { ingestMessage, markUpdateProcessed, recordBotMessage, touchMember } from "@/lib/ingest";
import { runAgent } from "@/lib/agent";
import { type Attachment, downloadTelegramFile, fetchAnthropicFile, uploadAttachment } from "@/lib/files";
import { getGranolaToken } from "@/lib/granola";

export const maxDuration = 300;

const KINDS = ["mentoring", "client", "team", "personal", "generic"];

// A document or photo on this message, or on the one it replies to.
function pickFile(m?: Message): { fileId: string; fileName: string } | null {
  if (!m) return null;
  if (m.document) return { fileId: m.document.file_id, fileName: m.document.file_name ?? "document" };
  if (m.photo?.length) return { fileId: m.photo[m.photo.length - 1].file_id, fileName: "photo.jpg" };
  return null;
}

async function handleUpdate(botId: string, update: Update) {
  const bot = await getTelegramBot(botId);
  const fresh = await markUpdateProcessed(botId, update.update_id);
  if (!fresh) return;

  const msg = update.message ?? update.edited_message;
  if (!msg) return;

  // Build a grammY context so we get the same helpers everywhere.
  const { Context } = await import("grammy");
  const ctx = new Context(update, bot.api, bot.botInfo);

  const { space, person } = await ingestMessage(botId, ctx);
  const text = msg.text ?? msg.caption ?? "";
  const chatId = msg.chat.id;
  const isOwner = Boolean(person?.isOwner);

  // ---- Commands -------------------------------------------------------
  if (text.startsWith("/id")) {
    await sendPlain(bot, chatId, `Ваш user id: ${msg.from?.id}\nchat id: ${chatId}`, msg.message_id);
    return;
  }
  if (text.startsWith("/setup")) {
    if (!isOwner) {
      await sendPlain(bot, chatId, "Настраивать space может только владелец бота.", msg.message_id);
      return;
    }
    // /setup kind=mentoring tz=Europe/Lisbon persona=...
    const args = Object.fromEntries(
      [...text.matchAll(/(\w+)=("[^"]*"|\S+)/g)].map((m) => [m[1], m[2].replace(/^"|"$/g, "")]),
    );
    const patch: Partial<typeof schema.spaces.$inferInsert> = {};
    if (args.kind && KINDS.includes(args.kind)) patch.kind = args.kind;
    if (args.tz) patch.timezone = args.tz;
    if (args.persona) patch.template = { ...space.template, persona: args.persona };
    if (Object.keys(patch).length) await db.update(schema.spaces).set(patch).where(eq(schema.spaces.id, space.id));
    if (person) await touchMember(space.id, person.id, "owner");
    await sendPlain(
      bot,
      chatId,
      `Space настроен.\nkind=${patch.kind ?? space.kind} tz=${patch.timezone ?? space.timezone}` +
        `\nДоступно: /setup kind=mentoring|client|team|personal tz=Europe/Lisbon persona="..."`,
      msg.message_id,
    );
    return;
  }
  if (text.startsWith("/status")) {
    const tasks = await db.query.tasks.findMany({
      where: (t, { and, eq }) => and(eq(t.spaceId, space.id), eq(t.status, "open")),
      orderBy: (t, { asc }) => asc(t.dueAt),
    });
    const body = tasks.length
      ? tasks.map((t) => `• [${t.id.slice(0, 8)}] ${t.title}${t.dueAt ? ` — до ${t.dueAt.toISOString().slice(0, 10)}` : ""}`).join("\n")
      : "Открытых задач нет.";
    await sendPlain(bot, chatId, body, msg.message_id);
    return;
  }

  // ---- Agent ----------------------------------------------------------
  const addressed = isAddressedToBot(ctx) || text.startsWith("/ask");
  if (!addressed) return;

  // Hand the agent any attachment on this message, or on the one it replies to.
  const tgFile = pickFile(msg) ?? pickFile(msg.reply_to_message);
  const attachments: Attachment[] = [];
  let attachNote = "";
  if (tgFile) {
    try {
      const dl = await downloadTelegramFile(botId, bot, tgFile.fileId, tgFile.fileName);
      attachments.push(await uploadAttachment(dl.bytes, dl.fileName, dl.mime));
      attachNote = `\n(приложен файл: ${dl.fileName})`;
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      console.error("attachment failed", err);
      attachNote = `\n(файл приложен, но получить его не удалось: ${err})`;
    }
  }
  if (!text.trim() && !attachments.length) return;

  const trigger = msg.chat.type === "private" ? "dm" : msg.reply_to_message ? "reply" : text.startsWith("/ask") ? "command" : "mention";
  const clean = stripMention(ctx, text.replace(/^\/ask(@\w+)?\s*/, ""));
  const quoted = msg.reply_to_message?.text ? `\n(в ответ на #${msg.reply_to_message.message_id}: ${msg.reply_to_message.text})` : "";

  // Granola holds the owner's own meetings, so only the owner gets the toolset.
  // Everyone else's request is built without it, so there is nothing to bypass.
  const granolaToken = person?.isOwner ? await getGranolaToken() : null;

  await bot.api.sendChatAction(chatId, "typing").catch(() => {});
  try {
    const res = await runAgent({
      space,
      trigger,
      text: clean + quoted + attachNote,
      askedBy: person ? { id: person.id, label: `${person.firstName ?? ""} ${person.username ? "@" + person.username : ""}`.trim() } : null,
      sourceTgMessageId: msg.message_id,
      attachments,
      granolaToken,
    });
    const sentMsgs = await sendPlain(bot, chatId, res.text, msg.message_id);
    for (const m of sentMsgs) await recordBotMessage(space.id, m.message_id, m.text ?? "");

    // Deliver whatever the sandbox produced as real Telegram documents.
    for (const fileId of res.generatedFileIds) {
      try {
        const f = await fetchAnthropicFile(fileId);
        const doc = await bot.api.sendDocument(chatId, new InputFile(f.bytes, f.fileName));
        await recordBotMessage(space.id, doc.message_id, `[файл] ${f.fileName}`);
      } catch (e) {
        console.error("send generated file failed", fileId, e);
      }
    }
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    console.error("agent error", err);
    await db.insert(schema.agentRuns).values({ spaceId: space.id, trigger, input: clean, error: err });
    await sendPlain(bot, chatId, "Не получилось ответить, ошибка записана в лог.", msg.message_id);
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ botId: string }> }) {
  const { botId } = await params;
  try {
    getBot(botId);
  } catch {
    return new Response("unknown bot", { status: 404 });
  }
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (secret && req.headers.get("x-telegram-bot-api-secret-token") !== secret) {
    return new Response("forbidden", { status: 403 });
  }
  const update = (await req.json()) as Update;
  // Ack Telegram immediately; do the work after the response is sent.
  waitUntil(handleUpdate(botId, update).catch((e) => console.error("update failed", e)));
  return new Response("ok");
}

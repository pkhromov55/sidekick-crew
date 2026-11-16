import { waitUntil } from "@vercel/functions";
import { InputFile } from "grammy";
import type { Message, Update } from "grammy/types";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { getBot } from "@/lib/bots";
import { getTelegramBot, isAddressedToBot, sendPlain, stripMention } from "@/lib/telegram";
import { ingestMessage, markUpdateProcessed, recordBotMessage, touchMember } from "@/lib/ingest";
import { runAgent } from "@/lib/agent";
import { type Attachment, downloadTelegramFile, fetchAnthropicFile, uploadAttachment } from "@/lib/files";
import { getGranolaToken } from "@/lib/granola";
import { extractFromMessage, shouldExtract } from "@/lib/extract";
import { TEMPLATES } from "@/lib/templates";
import { forwardLabel, personLabel } from "@/lib/context";

export const maxDuration = 300;

const KINDS = ["mentoring", "client", "team", "personal", "project", "generic"];

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
  const threadId = msg.is_topic_message && msg.message_thread_id ? msg.message_thread_id : undefined;
  const isOwner = Boolean(person?.isOwner);

  // ---- Commands -------------------------------------------------------
  if (text.startsWith("/id")) {
    await sendPlain(bot, chatId, `Ваш user id: ${msg.from?.id}\nchat id: ${chatId}`, msg.message_id, threadId);
    return;
  }
  if (text.startsWith("/setup")) {
    if (!isOwner) {
      await sendPlain(bot, chatId, "Настраивать space может только владелец бота.", msg.message_id, threadId);
      return;
    }
    // /setup kind=mentoring tz=Europe/Lisbon persona=...
    const args = Object.fromEntries(
      [...text.matchAll(/(\w+)=("[^"]*"|\S+)/g)].map((m) => [m[1], m[2].replace(/^"|"$/g, "")]),
    );
    const patch: Partial<typeof schema.spaces.$inferInsert> = {};
    let template = { ...space.template };
    if (args.template) {
      const tpl = TEMPLATES[args.template];
      if (!tpl) {
        await sendPlain(bot, chatId, `Нет такого шаблона. Есть: ${Object.keys(TEMPLATES).join(", ")}`, msg.message_id, threadId);
        return;
      }
      patch.kind = tpl.kind;
      template = { ...template, template: tpl.id, extract: tpl.extract };
    }
    if (args.kind && KINDS.includes(args.kind)) patch.kind = args.kind;
    if (args.tz) patch.timezone = args.tz;
    if (args.persona) template = { ...template, persona: args.persona };
    if (args.extract) template = { ...template, extract: args.extract === "on" || args.extract === "1" || args.extract === "true" };
    if (args.digest) {
      if (args.digest === "off") {
        template = { ...template, digest: undefined };
      } else {
        const m = /^(\d{1,2})(?::(\d{2}))?$/.exec(args.digest);
        if (!m) {
          await sendPlain(bot, chatId, "Формат: /setup digest=09:00 (в той теме, куда слать) или digest=off", msg.message_id, threadId);
          return;
        }
        template = { ...template, digest: { threadId: threadId ?? null, hour: Number(m[1]), minute: Number(m[2] ?? 0) } };
      }
    }
    patch.template = template;
    await db.update(schema.spaces).set(patch).where(eq(schema.spaces.id, space.id));
    if (person) await touchMember(space.id, person.id, "owner");
    await sendPlain(
      bot,
      chatId,
      `Space настроен.\nkind=${patch.kind ?? space.kind} template=${template.template ?? "-"} extract=${template.extract ? "on" : "off"} tz=${patch.timezone ?? space.timezone}` +
        (template.digest ? `\nежедневный список задач: ${String(template.digest.hour).padStart(2, "0")}:${String(template.digest.minute).padStart(2, "0")}${template.digest.threadId ? " в этой теме" : ""}` : "") +
        `\nДоступно: /setup template=${Object.keys(TEMPLATES).join("|")} kind=... tz=Europe/Lisbon extract=on|off digest=09:00|off persona="..."`,
      msg.message_id,
      threadId,
    );
    return;
  }
  // /doc Title  — with a text-like file attached (or in reply to one): store as a knowledge document.
  if (text.startsWith("/doc")) {
    if (!isOwner) {
      await sendPlain(bot, chatId, "Добавлять документы может только владелец.", msg.message_id, threadId);
      return;
    }
    const src = msg.document ? msg : msg.reply_to_message?.document ? msg.reply_to_message : null;
    const title = text.replace(/^\/doc(@\w+)?\s*/, "").trim() || src?.document?.file_name || "Документ";
    if (!src?.document) {
      const docs = await db.query.documents.findMany({ where: (d, { eq }) => eq(d.spaceId, space.id) });
      await sendPlain(
        bot,
        chatId,
        (docs.length ? docs.map((d) => `• [${d.id.slice(0, 8)}] ${d.title} (${d.content.length} символов)`).join("\n") : "Документов нет.") +
          "\n\nЧтобы добавить: пришли .txt/.md/.csv с подписью «/doc Название» или ответь так на файл.",
        msg.message_id,
        threadId,
      );
      return;
    }
    const name = src.document.file_name ?? "file";
    if (!/\.(txt|md|csv|tsv|json|html?)$/i.test(name)) {
      await sendPlain(bot, chatId, "Пока принимаю только текстовые файлы: .txt, .md, .csv. PDF и docx — позже.", msg.message_id, threadId);
      return;
    }
    try {
      const dl = await downloadTelegramFile(botId, bot, src.document.file_id, name);
      const content = new TextDecoder("utf-8").decode(dl.bytes);
      const [d] = await db.insert(schema.documents).values({ spaceId: space.id, title, content, source: name }).returning();
      await sendPlain(bot, chatId, `Документ сохранён: [${d.id.slice(0, 8)}] ${title}, ${content.length} символов.`, msg.message_id, threadId);
    } catch (e) {
      await sendPlain(bot, chatId, `Не удалось сохранить документ: ${e instanceof Error ? e.message : String(e)}`, msg.message_id, threadId);
    }
    return;
  }
  // /forget — in reply to any message: hide it from the bot's context and search.
  // Telegram does not tell bots about deletions, so this is the only way to make the bot forget.
  if (text.startsWith("/forget")) {
    const target = msg.reply_to_message;
    if (!target) {
      await sendPlain(bot, chatId, "Ответь командой /forget на сообщение, которое бот должен забыть.", msg.message_id, threadId);
      return;
    }
    const rows = await db
      .update(schema.messages)
      .set({ hidden: true })
      .where(and(eq(schema.messages.spaceId, space.id), eq(schema.messages.tgMessageId, target.message_id)))
      .returning({ id: schema.messages.id });
    await db.update(schema.messages).set({ hidden: true }).where(and(eq(schema.messages.spaceId, space.id), eq(schema.messages.tgMessageId, msg.message_id)));
    await sendPlain(
      bot,
      chatId,
      rows.length
        ? "Забыл это сообщение: его больше нет в контексте и поиске. Записи и память, созданные по нему, можно убрать отдельно: «забудь запись/факт …»."
        : "Этого сообщения нет в журнале (бот его не видел).",
      msg.message_id,
      threadId,
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
    await sendPlain(bot, chatId, body, msg.message_id, threadId);
    return;
  }

  // ---- Agent ----------------------------------------------------------
  const addressed = isAddressedToBot(ctx) || text.startsWith("/ask");
  if (!addressed) {
    if (shouldExtract(space, text, Boolean(msg.from?.is_bot))) {
      try {
        const fwd = forwardLabel(msg.forward_origin ? { forward_origin: msg.forward_origin } : null);
        const n = await extractFromMessage({
          space,
          text,
          author: personLabel(person),
          forwardedFrom: fwd,
          tgMessageId: msg.message_id,
        });
        if (n.records || n.facts) console.log("extracted", space.id, n);
      } catch (e) {
        console.error("extract failed", e instanceof Error ? e.message : e);
      }
    }
    return;
  }

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

  await bot.api.sendChatAction(chatId, "typing", { message_thread_id: threadId }).catch(() => {});
  try {
    const res = await runAgent({
      space,
      trigger,
      text: clean + quoted + attachNote,
      askedBy: person ? { id: person.id, label: `${person.firstName ?? ""} ${person.username ? "@" + person.username : ""}`.trim() } : null,
      sourceTgMessageId: msg.message_id,
      threadId: threadId ?? null,
      attachments,
      granolaToken,
    });
    const sentMsgs = await sendPlain(bot, chatId, res.text, msg.message_id, threadId);
    for (const m of sentMsgs) await recordBotMessage(space.id, m.message_id, m.text ?? "");

    // Deliver whatever the sandbox produced as real Telegram documents.
    for (const fileId of res.generatedFileIds) {
      try {
        const f = await fetchAnthropicFile(fileId);
        const doc = await bot.api.sendDocument(chatId, new InputFile(f.bytes, f.fileName), { message_thread_id: threadId });
        await recordBotMessage(space.id, doc.message_id, `[файл] ${f.fileName}`);
      } catch (e) {
        console.error("send generated file failed", fileId, e);
      }
    }
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    console.error("agent error", err);
    await db.insert(schema.agentRuns).values({ spaceId: space.id, trigger, input: clean, error: err });
    await sendPlain(bot, chatId, "Не получилось ответить, ошибка записана в лог.", msg.message_id, threadId);
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

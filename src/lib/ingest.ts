import type { Context } from "grammy";
import { eq, and, sql } from "drizzle-orm";
import { db, schema } from "@/db";

export type Ingested = {
  space: typeof schema.spaces.$inferSelect;
  person: typeof schema.people.$inferSelect | null;
  message: typeof schema.messages.$inferSelect | null;
};

export async function ensureSpace(botId: string, ctx: Context) {
  const chat = ctx.chat!;
  const title = chat.type === "private" ? [chat.first_name, chat.last_name].filter(Boolean).join(" ") : chat.title;
  const [space] = await db
    .insert(schema.spaces)
    .values({ botId, tgChatId: chat.id, title: title ?? null, chatType: chat.type })
    .onConflictDoUpdate({
      target: [schema.spaces.botId, schema.spaces.tgChatId],
      set: { title: title ?? null, chatType: chat.type },
    })
    .returning();
  return space;
}

export async function ensurePerson(ctx: Context) {
  const from = ctx.from;
  if (!from || from.is_bot) return null;
  const ownerId = Number(process.env.OWNER_TG_USER_ID ?? 0);
  const [person] = await db
    .insert(schema.people)
    .values({
      tgUserId: from.id,
      username: from.username ?? null,
      firstName: from.first_name ?? null,
      lastName: from.last_name ?? null,
      isOwner: from.id === ownerId,
    })
    .onConflictDoUpdate({
      target: schema.people.tgUserId,
      set: {
        username: from.username ?? null,
        firstName: from.first_name ?? null,
        lastName: from.last_name ?? null,
        isOwner: from.id === ownerId,
      },
    })
    .returning();
  return person;
}

export async function touchMember(spaceId: string, personId: string, role?: string) {
  await db
    .insert(schema.spaceMembers)
    .values({ spaceId, personId, role: role ?? "member", lastSeenAt: new Date() })
    .onConflictDoUpdate({
      target: [schema.spaceMembers.spaceId, schema.spaceMembers.personId],
      set: role ? { role, lastSeenAt: new Date() } : { lastSeenAt: new Date() },
    });
}

// Persist one incoming Telegram message into the event log.
export async function ingestMessage(botId: string, ctx: Context): Promise<Ingested> {
  const msg = ctx.message ?? ctx.editedMessage;
  const space = await ensureSpace(botId, ctx);
  const person = await ensurePerson(ctx);
  if (!msg) return { space, person, message: null };
  if (person) await touchMember(space.id, person.id, person.isOwner ? "owner" : undefined);

  let kind = "text";
  let fileId: string | null = null;
  let fileName: string | null = null;
  if (msg.photo?.length) {
    kind = "photo";
    fileId = msg.photo[msg.photo.length - 1].file_id;
  } else if (msg.document) {
    kind = "document";
    fileId = msg.document.file_id;
    fileName = msg.document.file_name ?? null;
  } else if (msg.voice) {
    kind = "voice";
    fileId = msg.voice.file_id;
  } else if (msg.video) {
    kind = "video";
    fileId = msg.video.file_id;
  } else if (msg.sticker) {
    kind = "sticker";
  } else if (msg.new_chat_members || msg.left_chat_member || msg.pinned_message) {
    kind = "system";
  }

  const [message] = await db
    .insert(schema.messages)
    .values({
      spaceId: space.id,
      tgMessageId: msg.message_id,
      personId: person?.id ?? null,
      fromBot: Boolean(msg.from?.is_bot),
      kind,
      text: msg.text ?? msg.caption ?? null,
      replyToTgMessageId: msg.reply_to_message?.message_id ?? null,
      fileId,
      fileName,
      meta: msg.forward_origin ? { forward_origin: msg.forward_origin } : null,
      sentAt: new Date(msg.date * 1000),
    })
    .onConflictDoNothing()
    .returning();
  return { space, person, message: message ?? null };
}

// Record the bot's own outgoing message so the transcript stays complete.
export async function recordBotMessage(spaceId: string, tgMessageId: number, text: string) {
  await db
    .insert(schema.messages)
    .values({ spaceId, tgMessageId, fromBot: true, kind: "text", text, sentAt: new Date() })
    .onConflictDoNothing();
}

export async function markUpdateProcessed(botId: string, updateId: number): Promise<boolean> {
  const rows = await db
    .insert(schema.processedUpdates)
    .values({ botId, updateId })
    .onConflictDoNothing()
    .returning({ updateId: schema.processedUpdates.updateId });
  return rows.length > 0;
}

export async function findSpaceByChat(botId: string, tgChatId: number) {
  return db.query.spaces.findFirst({
    where: and(eq(schema.spaces.botId, botId), eq(schema.spaces.tgChatId, tgChatId)),
  });
}

export const nowSql = sql`now()`;

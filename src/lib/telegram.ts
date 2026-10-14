import { Bot, type Context } from "grammy";
import { getBot } from "./bots";
import { env } from "./env";

const cache = new Map<string, Promise<Bot>>();

// One initialised grammY Bot per bot id (module-level cache survives warm invocations).
export function getTelegramBot(botId: string): Promise<Bot> {
  let p = cache.get(botId);
  if (!p) {
    p = (async () => {
      const cfg = getBot(botId);
      const bot = new Bot(env(cfg.tokenEnv));
      await bot.init();
      return bot;
    })();
    cache.set(botId, p);
  }
  return p;
}

export function isAddressedToBot(ctx: Context): boolean {
  const msg = ctx.message;
  if (!msg) return false;
  if (ctx.chat?.type === "private") return true;
  if (msg.reply_to_message?.from?.id === ctx.me.id) return true;
  const text = msg.text ?? msg.caption ?? "";
  const entities = msg.entities ?? msg.caption_entities ?? [];
  const me = `@${ctx.me.username}`.toLowerCase();
  return entities.some(
    (e) => e.type === "mention" && text.slice(e.offset, e.offset + e.length).toLowerCase() === me,
  );
}

export function stripMention(ctx: Context, text: string): string {
  return text.replace(new RegExp(`@${ctx.me.username}`, "gi"), "").trim();
}

// Telegram caps messages at 4096 chars; split on paragraph boundaries when possible.
export function splitForTelegram(text: string, limit = 4000): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n\n", limit);
    if (cut < limit / 2) cut = rest.lastIndexOf("\n", limit);
    if (cut < limit / 2) cut = rest.lastIndexOf(" ", limit);
    if (cut < limit / 2) cut = limit;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  out.push(rest);
  return out.filter((c) => c.length > 0);
}

export async function sendPlain(bot: Bot, chatId: number, text: string, replyTo?: number) {
  const chunks = splitForTelegram(text);
  const sent = [];
  let first = true;
  for (const chunk of chunks.length ? chunks : ["(пусто)"]) {
    sent.push(
      await bot.api.sendMessage(chatId, chunk, {
        reply_parameters: first && replyTo ? { message_id: replyTo } : undefined,
        link_preview_options: { is_disabled: true },
      }),
    );
    first = false;
  }
  return sent;
}

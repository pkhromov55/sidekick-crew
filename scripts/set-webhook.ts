// Registers the Telegram webhook for a bot id. Usage: npm run webhook:set -- crew
import { BOTS } from "../src/lib/bots.ts";

const botId = process.argv[2] ?? "crew";
const cfg = BOTS[botId];
if (!cfg) throw new Error(`unknown bot ${botId}`);
const token = process.env[cfg.tokenEnv];
const appUrl = process.env.APP_URL;
if (!token || !appUrl) throw new Error("need bot token and APP_URL in env");

const url = `${appUrl.replace(/\/$/, "")}/api/telegram/${botId}`;
const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    url,
    secret_token: process.env.TELEGRAM_WEBHOOK_SECRET || undefined,
    allowed_updates: ["message", "edited_message", "my_chat_member", "chat_member"],
    drop_pending_updates: false,
  }),
});
console.log(url, await res.json());

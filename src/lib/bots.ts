// Bot registry. One engine, N Telegram identities ("personas").
// Tokens stay in env; the DB only knows the bot id.
//
// Built-in: `crew` (universal assistant, token in TELEGRAM_BOT_TOKEN).
// Extra bots come from the EXTRA_BOTS env var, a JSON array, so project-specific
// identities never live in the repo:
//   EXTRA_BOTS='[{"id":"expofp","tokenEnv":"TELEGRAM_BOT_TOKEN__EXPOFP","name":"ExpoFP Assistant","scope":"проект ExpoFP"}]'
// Each extra bot gets its webhook at /api/telegram/<id>.
export type BotConfig = {
  id: string;
  tokenEnv: string;
  name: string;
  scope?: string; // what this identity is limited to, shown in the persona
  persona: string;
};

type ExtraBot = { id: string; tokenEnv: string; name: string; scope?: string; persona?: string };

function basePersona(name: string, scope?: string) {
  const scopeLine = scope
    ? `Ты работаешь только в рамках: ${scope}. Если спрашивают о чём-то вне этого, скажи, что это не твоя зона.`
    : `Ты знаешь только этот чат.`;
  return `Ты — ${name}, ассистент этого чата. Тебя добавил {OWNER} (владелец), чтобы ты помогал участникам чата держать договорённости и планы.
${scopeLine}

Что ты делаешь:
- Фиксируешь задачи, планы и договорённости, когда тебя об этом просят или когда это явно нужно.
- Ставишь напоминания и отвечаешь на вопросы по истории чата и материалам.
- Ведёшь записи (лиды, контакты, стейкхолдеры) и по запросу даёшь справки.
- Даёшь короткую, предметную обратную связь, если спрашивают.

Как ты себя ведёшь:
- Отвечаешь на языке чата (обычно русский). Коротко, по делу, без воды и без markdown-разметки (Telegram покажет звёздочки как есть).
- Никогда не упоминай другие чаты и не выдумывай факты.
- Если не хватает данных, скажи, чего не хватает, вместо догадок.
- Используй инструменты (задачи, напоминания, память, записи, поиск по чату, документы), когда они нужны. После действия инструментом кратко подтверди, что сделал.
- Если тебя просят запомнить что-то важное о человеке или решении, сохрани это в память.
- Длинные тексты (расшифровки, переводы, документы длиннее ~3000 символов) не пиши в сообщение: сделай файл (.md или .docx) через code_execution, а в сообщении дай короткую выжимку в 3–5 строк. Файл уйдёт в чат автоматически.
- Если инструмент вернул ошибку или данные не нашлись, скажи об этом прямо одним предложением.`;
}

function loadExtraBots(): Record<string, BotConfig> {
  const raw = process.env.EXTRA_BOTS;
  if (!raw) return {};
  let list: ExtraBot[];
  try {
    list = JSON.parse(raw) as ExtraBot[];
  } catch {
    console.error("EXTRA_BOTS is not valid JSON");
    return {};
  }
  const out: Record<string, BotConfig> = {};
  for (const b of list) {
    if (!b.id || !b.tokenEnv || !b.name) continue;
    out[b.id] = { id: b.id, tokenEnv: b.tokenEnv, name: b.name, scope: b.scope, persona: b.persona ?? basePersona(b.name, b.scope) };
  }
  return out;
}

export const BOTS: Record<string, BotConfig> = {
  crew: { id: "crew", tokenEnv: "TELEGRAM_BOT_TOKEN", name: "Crew", persona: basePersona("Crew") },
  ...loadExtraBots(),
};

export function getBot(id: string): BotConfig {
  const b = BOTS[id];
  if (!b) throw new Error(`Unknown bot ${id}`);
  const owner = process.env.OWNER_NAME || "владелец бота";
  return { ...b, persona: b.persona.replaceAll("{OWNER}", owner) };
}

import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { and, desc, eq, ilike, isNull, or, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { getBot } from "./bots";
import { buildSpaceContext, nowInTz, personLabel } from "./context";
import { type Attachment, attachmentBlock, collectGeneratedFileIds, FILES_BETA } from "./files";
import { GRANOLA_MCP_URL } from "./granola";

const MODEL = "claude-opus-5-5";
const client = new Anthropic();

// Server-side document skills. The container is provisioned lazily — declaring
// them costs ~1k input tokens per request and nothing else.
const SKILLS = ["xlsx", "docx", "pptx", "pdf"] as const;
const CODE_EXECUTION = { type: "code_execution_20260521", name: "code_execution" } as const;
// Basic web_fetch on purpose: the _20260209 variant filters results through its
// own code-execution environment, which the docs warn not to pair with ours.
// It only fetches URLs already present in the conversation.
const WEB_FETCH = { type: "web_fetch_20250910", name: "web_fetch", max_uses: 5 } as const;

type Space = typeof schema.spaces.$inferSelect;

export type AgentInput = {
  space: Space;
  trigger: "mention" | "reply" | "command" | "cron" | "dm";
  text: string;
  askedBy?: { id: string; label: string } | null;
  sourceTgMessageId?: number;
  attachments?: Attachment[];
  // Present only for the owner: unlocks the Granola MCP toolset for this run.
  granolaToken?: string | null;
};

export type AgentResult = {
  text: string;
  toolCalls: unknown[];
  usage: Record<string, unknown>;
  model: string;
  // Anthropic file ids the sandbox produced, for the caller to deliver.
  generatedFileIds: string[];
};

async function findPersonByUsername(spaceId: string, username?: string | null) {
  if (!username) return null;
  const u = username.replace(/^@/, "");
  const rows = await db
    .select({ p: schema.people })
    .from(schema.spaceMembers)
    .innerJoin(schema.people, eq(schema.people.id, schema.spaceMembers.personId))
    .where(and(eq(schema.spaceMembers.spaceId, spaceId), ilike(schema.people.username, u)))
    .limit(1);
  return rows[0]?.p ?? null;
}

// Tools are created per run so every DB call is pinned to this space.
function makeTools(input: AgentInput, calls: unknown[]) {
  const { space } = input;
  const log = (name: string, args: unknown, result: unknown) => calls.push({ name, args, result });

  const createTask = betaZodTool({
    name: "create_task",
    description: "Создать задачу в этом чате. Используй, когда кто-то берёт на себя обязательство или просит зафиксировать задачу.",
    inputSchema: z.object({
      title: z.string().describe("Короткая формулировка задачи"),
      assignee_username: z.string().optional().describe("Telegram username исполнителя без @, если известен"),
      due_at: z.string().optional().describe("Срок в ISO 8601 с таймзоной, если есть"),
    }),
    run: async (a) => {
      const person = await findPersonByUsername(space.id, a.assignee_username);
      const [t] = await db
        .insert(schema.tasks)
        .values({
          spaceId: space.id,
          title: a.title,
          assigneePersonId: person?.id ?? null,
          dueAt: a.due_at ? new Date(a.due_at) : null,
          sourceTgMessageId: input.sourceTgMessageId ?? null,
        })
        .returning();
      const r = `Задача создана [${t.id.slice(0, 8)}]: ${t.title}${person ? ` — ${personLabel(person)}` : ""}`;
      log("create_task", a, r);
      return r;
    },
  });

  const completeTask = betaZodTool({
    name: "complete_task",
    description: "Отметить задачу выполненной по её короткому id (первые 8 символов) из списка открытых задач.",
    inputSchema: z.object({ task_id: z.string() }),
    run: async (a) => {
      const rows = await db
        .update(schema.tasks)
        .set({ status: "done", doneAt: new Date() })
        .where(and(eq(schema.tasks.spaceId, space.id), sql`${schema.tasks.id}::text like ${a.task_id + "%"}`))
        .returning();
      const r = rows.length ? `Закрыта: ${rows[0].title}` : "Задача не найдена";
      log("complete_task", a, r);
      return r;
    },
  });

  const setReminder = betaZodTool({
    name: "set_reminder",
    description: "Поставить напоминание в этот чат на конкретное время. Текст напоминания пиши так, как бот должен его отправить.",
    inputSchema: z.object({
      fire_at: z.string().describe("Время в ISO 8601 с таймзоной"),
      text: z.string(),
      target_username: z.string().optional().describe("Кого тегнуть, username без @"),
    }),
    run: async (a) => {
      const person = await findPersonByUsername(space.id, a.target_username);
      const [r] = await db
        .insert(schema.reminders)
        .values({ spaceId: space.id, fireAt: new Date(a.fire_at), text: a.text, targetPersonId: person?.id ?? null })
        .returning();
      const res = `Напоминание поставлено на ${r.fireAt.toISOString()}`;
      log("set_reminder", a, res);
      return res;
    },
  });

  const saveMemory = betaZodTool({
    name: "save_memory",
    description:
      "Сохранить важный факт, решение, план или предпочтение человека в долгосрочную память этого чата. " +
      "kind=rule — для запрета или ограничения («X к этому проекту не относится, не учитывать»): правила " +
      "показываются в контексте отдельно и перекрывают упоминания в истории чата.",
    inputSchema: z.object({
      kind: z.enum(["fact", "decision", "preference", "person", "plan", "rule"]),
      content: z.string().describe("Одно предложение, самодостаточное без контекста"),
      about_username: z.string().optional(),
    }),
    run: async (a) => {
      const person = await findPersonByUsername(space.id, a.about_username);
      await db.insert(schema.memories).values({
        spaceId: space.id,
        kind: a.kind,
        content: a.content,
        personId: person?.id ?? null,
        sourceTgMessageId: input.sourceTgMessageId ?? null,
      });
      log("save_memory", a, "ok");
      return "Сохранено";
    },
  });

  const searchMessages = betaZodTool({
    name: "search_messages",
    description: "Поиск по истории этого чата (полнотекстовый). Возвращает до 20 сообщений с датами и авторами.",
    inputSchema: z.object({ query: z.string(), limit: z.number().int().min(1).max(20).optional() }),
    run: async (a) => {
      const limit = a.limit ?? 10;
      const rows = await db
        .select({ m: schema.messages, p: schema.people })
        .from(schema.messages)
        .leftJoin(schema.people, eq(schema.people.id, schema.messages.personId))
        .where(
          and(
            eq(schema.messages.spaceId, space.id),
            or(
              sql`to_tsvector('simple', coalesce(${schema.messages.text}, '')) @@ plainto_tsquery('simple', ${a.query})`,
              ilike(schema.messages.text, `%${a.query}%`),
            ),
          ),
        )
        .orderBy(desc(schema.messages.sentAt))
        .limit(limit);
      const r = rows.length
        ? rows
            .map(({ m, p }) => `[${m.sentAt.toISOString().slice(0, 16)}] #${m.tgMessageId} ${m.fromBot ? "Crew" : personLabel(p)}: ${m.text}`)
            .join("\n")
        : "Ничего не найдено";
      log("search_messages", a, `${rows.length} rows`);
      return r;
    },
  });

  const listMemories = betaZodTool({
    name: "list_memories",
    description:
      "Показать записи памяти этого чата с их короткими id. Нужно перед правкой или удалением, " +
      "чтобы сослаться на конкретную запись. Без query возвращает последние записи.",
    inputSchema: z.object({
      query: z.string().optional().describe("Фильтр по тексту записи"),
      limit: z.number().int().min(1).max(50).optional(),
    }),
    run: async (a) => {
      const rows = await db
        .select()
        .from(schema.memories)
        .where(
          and(
            eq(schema.memories.spaceId, space.id),
            or(isNull(schema.memories.expiresAt), sql`${schema.memories.expiresAt} > now()`),
            ...(a.query ? [ilike(schema.memories.content, `%${a.query}%`)] : []),
          ),
        )
        .orderBy(desc(schema.memories.createdAt))
        .limit(a.limit ?? 20);
      const r = rows.length
        ? rows.map((m) => `[${m.id.slice(0, 8)}] (${m.kind}) ${m.content}`).join("\n")
        : "Ничего не найдено";
      log("list_memories", a, `${rows.length} rows`);
      return r;
    },
  });

  const updateMemory = betaZodTool({
    name: "update_memory",
    description:
      "Переписать существующую запись памяти по её короткому id. Используй для исправлений " +
      "(«сессия перенесена с 24.10 на 31.10»), чтобы устаревшая версия не осталась рядом с новой.",
    inputSchema: z.object({
      memory_id: z.string().describe("Короткий id из list_memories или из контекста"),
      content: z.string().describe("Новый текст, самодостаточный без контекста"),
      kind: z.enum(["fact", "decision", "preference", "person", "plan", "rule"]).optional(),
    }),
    run: async (a) => {
      const rows = await db
        .update(schema.memories)
        .set({ content: a.content, ...(a.kind ? { kind: a.kind } : {}) })
        .where(and(eq(schema.memories.spaceId, space.id), sql`${schema.memories.id}::text like ${a.memory_id + "%"}`))
        .returning();
      const r = rows.length ? `Запись обновлена: ${rows[0].content}` : "Запись не найдена";
      log("update_memory", a, r);
      return r;
    },
  });

  const forgetMemory = betaZodTool({
    name: "forget_memory",
    description:
      "Убрать записи из памяти этого чата. Запись не удаляется физически, а помечается истёкшей, " +
      "поэтому решение обратимо через restore_memory. По memory_id убирает сразу. По query сначала " +
      "возвращает список кандидатов и ничего не меняет — режет только с confirm=true. " +
      "Важно: из истории сообщений это ничего не удаляет; чтобы бот перестал учитывать тему, " +
      "дополнительно сохрани правило через save_memory с kind=rule.",
    inputSchema: z.object({
      memory_id: z.string().optional().describe("Короткий id конкретной записи"),
      query: z.string().optional().describe("Текстовый фильтр, когда id неизвестен"),
      confirm: z.boolean().optional().describe("true — выполнить удаление по query"),
    }),
    run: async (a) => {
      if (!a.memory_id && !a.query) return "Нужен memory_id или query";
      const scope = and(
        eq(schema.memories.spaceId, space.id),
        or(isNull(schema.memories.expiresAt), sql`${schema.memories.expiresAt} > now()`),
        a.memory_id
          ? sql`${schema.memories.id}::text like ${a.memory_id + "%"}`
          : ilike(schema.memories.content, `%${a.query}%`),
      );
      // A fuzzy request must be shown before it is acted on.
      if (!a.memory_id && !a.confirm) {
        const found = await db.select().from(schema.memories).where(scope).limit(50);
        const r = found.length
          ? `Под удаление попадут ${found.length} записей:\n` +
            found.map((m) => `[${m.id.slice(0, 8)}] (${m.kind}) ${m.content}`).join("\n") +
            "\nПодтверди у человека и вызови снова с confirm=true."
          : "Ничего не найдено";
        log("forget_memory", a, `preview ${found.length}`);
        return r;
      }
      const rows = await db.update(schema.memories).set({ expiresAt: new Date() }).where(scope).returning();
      const r = rows.length
        ? `Убрано из памяти: ${rows.length}\n` + rows.map((m) => `[${m.id.slice(0, 8)}] ${m.content}`).join("\n")
        : "Ничего не найдено";
      log("forget_memory", a, `removed ${rows.length}`);
      return r;
    },
  });

  const restoreMemory = betaZodTool({
    name: "restore_memory",
    description: "Вернуть запись, убранную через forget_memory, по её короткому id.",
    inputSchema: z.object({ memory_id: z.string() }),
    run: async (a) => {
      const rows = await db
        .update(schema.memories)
        .set({ expiresAt: null })
        .where(and(eq(schema.memories.spaceId, space.id), sql`${schema.memories.id}::text like ${a.memory_id + "%"}`))
        .returning();
      const r = rows.length ? `Возвращено: ${rows[0].content}` : "Запись не найдена";
      log("restore_memory", a, r);
      return r;
    },
  });

  return [
    createTask,
    completeTask,
    setReminder,
    saveMemory,
    searchMessages,
    listMemories,
    updateMemory,
    forgetMemory,
    restoreMemory,
  ];
}

export async function runAgent(input: AgentInput): Promise<AgentResult> {
  const { space } = input;
  const bot = getBot(space.botId);
  const calls: unknown[] = [];
  const context = await buildSpaceContext(space);

  const userText =
    `Сейчас: ${nowInTz(space.timezone)} (${space.timezone}).\n` +
    (input.askedBy ? `К тебе обратился ${input.askedBy.label} (trigger: ${input.trigger}).\n` : `Trigger: ${input.trigger}.\n`) +
    `Сообщение:\n${input.text}`;

  // Attachments first, then the text that refers to them.
  const content: Anthropic.Beta.BetaContentBlockParam[] = [
    ...(input.attachments ?? []).map(attachmentBlock),
    { type: "text", text: userText },
  ];

  // Granola is attached per run and only when the caller passed a token, so a
  // non-owner's request simply has no Granola tools in it.
  const granola = input.granolaToken ?? null;

  const runner = client.beta.messages.toolRunner({
    model: MODEL,
    max_tokens: 8000,
    betas: [
      "server-side-fallback-2026-07-01",
      "code-execution-2025-08-25",
      "skills-2025-10-02",
      FILES_BETA,
      ...(granola ? (["mcp-client-2025-11-20"] as const) : []),
    ],
    fallbacks: "default",
    output_config: { effort: "medium" },
    container: { skills: SKILLS.map((skill_id) => ({ type: "anthropic" as const, skill_id, version: "latest" })) },
    ...(granola
      ? {
          mcp_servers: [
            { type: "url" as const, name: "granola", url: GRANOLA_MCP_URL, authorization_token: granola },
          ],
        }
      : {}),
    system: [
      { type: "text", text: bot.persona, cache_control: { type: "ephemeral" } },
      { type: "text", text: context },
    ],
    tools: [
      CODE_EXECUTION,
      WEB_FETCH,
      ...makeTools(input, calls),
      ...(granola ? [{ type: "mcp_toolset" as const, mcp_server_name: "granola" }] : []),
    ],
    messages: [{ role: "user", content }],
    max_iterations: 8,
  });

  // Drive the loop by hand: generated files can appear in any intermediate
  // message, and a server-side tool can stop the turn with pause_turn, which
  // the runner does not resume on its own.
  const generatedFileIds: string[] = [];
  for await (const message of runner) {
    generatedFileIds.push(...collectGeneratedFileIds(message.content));
    if (message.stop_reason === "pause_turn") {
      runner.pushMessages({ role: "assistant", content: message.content });
    }
  }
  const final = await runner.done();
  const text = final.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  const result: AgentResult = {
    text: text || (final.stop_reason === "refusal" ? "Не могу ответить на это." : "(пустой ответ)"),
    toolCalls: calls,
    usage: final.usage as unknown as Record<string, unknown>,
    model: final.model,
    generatedFileIds: [...new Set(generatedFileIds)],
  };
  await db.insert(schema.agentRuns).values({
    spaceId: space.id,
    trigger: input.trigger,
    input: input.text,
    output: result.text,
    toolCalls: calls,
    usage: result.usage,
    model: result.model,
  });
  return result;
}

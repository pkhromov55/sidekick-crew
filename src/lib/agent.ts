import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { getBot } from "./bots";
import { buildSpaceContext, nowInTz, personLabel } from "./context";

const MODEL = "claude-opus-5-5";
const client = new Anthropic();

type Space = typeof schema.spaces.$inferSelect;

export type AgentInput = {
  space: Space;
  trigger: "mention" | "reply" | "command" | "cron" | "dm";
  text: string;
  askedBy?: { id: string; label: string } | null;
  sourceTgMessageId?: number;
};

export type AgentResult = { text: string; toolCalls: unknown[]; usage: Record<string, unknown>; model: string };

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
    description: "Сохранить важный факт, решение, план или предпочтение человека в долгосрочную память этого чата.",
    inputSchema: z.object({
      kind: z.enum(["fact", "decision", "preference", "person", "plan"]),
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

  return [createTask, completeTask, setReminder, saveMemory, searchMessages];
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

  const runner = client.beta.messages.toolRunner({
    model: MODEL,
    max_tokens: 8000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "medium" },
    system: [
      { type: "text", text: bot.persona, cache_control: { type: "ephemeral" } },
      { type: "text", text: context },
    ],
    tools: makeTools(input, calls),
    messages: [{ role: "user", content: userText }],
    max_iterations: 8,
  });

  const final = await runner.runUntilDone();
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

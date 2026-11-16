// Passive extraction: for spaces with template.extract=true, every human message
// is read by a small model that pulls out records (leads, contacts, stakeholders)
// and durable facts. No reply is sent; the agent sees the results via context.
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { db, schema } from "@/db";
import { upsertRecord } from "./records";
import { getTemplate } from "./templates";

const client = new Anthropic();
const EXTRACT_MODEL = "claude-haiku-5-5";

const Extraction = z.object({
  records: z
    .array(
      z.object({
        kind: z.enum(["lead", "contact", "stakeholder", "company", "deal", "other"]),
        title: z.string().describe("Название компании или имя человека; одно на запись"),
        fields: z
          .array(z.object({ key: z.string(), value: z.string() }))
          .describe("Поля записи, например company, contact, email, country, source, stage, amount, next_step, next_date, notes"),
      }),
    )
    .describe("Пустой массив, если в сообщении нет сущностей"),
  facts: z
    .array(
      z.object({
        kind: z.enum(["fact", "decision", "preference", "person", "plan"]),
        content: z.string().describe("Одно самодостаточное предложение"),
      }),
    )
    .describe("Пустой массив, если в сообщении нет фактов, которые стоит помнить неделями"),
});

type Space = typeof schema.spaces.$inferSelect;

export function shouldExtract(space: Space, text: string, fromBot: boolean) {
  if (!space.template.extract) return false;
  if (fromBot) return false;
  if (text.trim().length < 25) return false;
  if (text.startsWith("/")) return false;
  return true;
}

export async function extractFromMessage(opts: {
  space: Space;
  text: string;
  author: string;
  forwardedFrom?: string | null;
  tgMessageId: number;
}) {
  const { space } = opts;
  const tpl = space.template.template ? getTemplate(space.template.template) : undefined;
  const persona = [tpl?.persona, space.template.persona].filter(Boolean).join("\n\n");

  const system =
    `Ты извлекаешь структурированные данные из одного сообщения рабочего чата. ` +
    `Возвращай только то, что явно сказано: не додумывай поля. Если сообщение бытовое или без сущностей, верни пустые массивы.\n\n` +
    (persona ? `Контекст пространства:\n${persona}` : "");

  const who = opts.forwardedFrom ? `${opts.author} переслал сообщение от ${opts.forwardedFrom}` : opts.author;
  const res = await client.messages.parse({
    model: EXTRACT_MODEL,
    max_tokens: 2000,
    output_config: { effort: "low", format: zodOutputFormat(Extraction) },
    system,
    messages: [{ role: "user", content: `Автор: ${who}\nСообщение:\n${opts.text}` }],
  });
  const out = res.parsed_output;
  if (!out) return { records: 0, facts: 0 };

  let nRecords = 0;
  for (const r of out.records) {
    const fields = Object.fromEntries(r.fields.map((f) => [f.key, f.value]));
    await upsertRecord(space.id, { kind: r.kind, title: r.title, fields, sourceTgMessageId: opts.tgMessageId });
    nRecords++;
  }
  if (out.facts.length) {
    await db.insert(schema.memories).values(
      out.facts.map((f) => ({
        spaceId: space.id,
        kind: f.kind,
        content: f.content,
        sourceTgMessageId: opts.tgMessageId,
      })),
    );
  }
  return { records: nRecords, facts: out.facts.length };
}

// Named Space templates. Applied with `/setup template=<id>` by the owner.
// Project-specific personas (people, terms, internal details) do not live here:
// put them in `spaces.template.persona` via scripts/seed-documents.ts (`_persona.md`).
// A template sets the space kind, extra persona instructions and whether the
// assistant passively extracts records/facts from every message.
export type Template = {
  id: string;
  kind: string;
  extract: boolean;
  persona: string;
};

export const TEMPLATES: Record<string, Template> = {
  mentoring: {
    id: "mentoring",
    kind: "mentoring",
    extract: false,
    persona: `Это менторский чат. Держи план сессий, фиксируй договорённости и домашние задания, напоминай о сроках. Будь поддерживающим, но прямым.`,
  },
  client: {
    id: "client",
    kind: "client",
    extract: false,
    persona: `Это чат с клиентом. Фиксируй запросы, сроки и решения. Не давай обещаний от имени владельца, если он сам этого не сказал.`,
  },
  team: {
    id: "team",
    kind: "team",
    extract: true,
    persona: `Это рабочий чат команды. Веди задачи и решения, напоминай об открытых пунктах.`,
  },
  project: {
    id: "project",
    kind: "project",
    extract: true,
    persona: `Это проектный чат. Ты — руки и глаза владельца в проекте: собираешь всё, что говорят участники, ведёшь записи (лиды, контакты, стейкхолдеры, сделки) и по запросу даёшь справки. Владелец может пересылать сюда сообщения из личных переписок: содержимое пересланного сообщения принадлежит его исходному автору, а не владельцу.`,
  },
};

export function getTemplate(id: string): Template | undefined {
  return TEMPLATES[id];
}

import {
  pgTable,
  text,
  bigint,
  bigserial,
  uuid,
  timestamp,
  jsonb,
  boolean,
  primaryKey,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

// A Space = one Telegram chat + everything the assistant knows about it.
export const spaces = pgTable(
  "spaces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    botId: text("bot_id").notNull(),
    tgChatId: bigint("tg_chat_id", { mode: "number" }).notNull(),
    title: text("title"),
    chatType: text("chat_type"), // private | group | supergroup
    kind: text("kind").notNull().default("generic"), // mentoring | client | team | personal | generic
    // Template: persona, rules, enabled tools, schedule. JSON so it is editable without a deploy.
    template: jsonb("template").$type<SpaceTemplate>().notNull().default({}),
    summary: text("summary"), // rolling summary, refreshed by cron
    timezone: text("timezone").notNull().default("UTC"),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("spaces_bot_chat").on(t.botId, t.tgChatId)],
);

export type SpaceTemplate = {
  persona?: string; // extra instructions for this space
  language?: string;
  digestCron?: string;
};

export const people = pgTable(
  "people",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tgUserId: bigint("tg_user_id", { mode: "number" }).notNull(),
    username: text("username"),
    firstName: text("first_name"),
    lastName: text("last_name"),
    isOwner: boolean("is_owner").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("people_tg_user").on(t.tgUserId)],
);

export const spaceMembers = pgTable(
  "space_members",
  {
    spaceId: uuid("space_id").notNull().references(() => spaces.id),
    personId: uuid("person_id").notNull().references(() => people.id),
    role: text("role").notNull().default("member"), // owner | mentor | mentee | client | member
    notes: text("notes"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.spaceId, t.personId] })],
);

// Append-only event log. Source of truth.
export const messages = pgTable(
  "messages",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    spaceId: uuid("space_id").notNull().references(() => spaces.id),
    tgMessageId: bigint("tg_message_id", { mode: "number" }).notNull(),
    personId: uuid("person_id").references(() => people.id),
    fromBot: boolean("from_bot").notNull().default(false),
    kind: text("kind").notNull().default("text"), // text | photo | document | voice | video | sticker | system
    text: text("text"),
    replyToTgMessageId: bigint("reply_to_tg_message_id", { mode: "number" }),
    fileId: text("file_id"),
    fileName: text("file_name"),
    meta: jsonb("meta").$type<Record<string, unknown>>(),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("messages_space_tg").on(t.spaceId, t.tgMessageId),
    index("messages_space_sent").on(t.spaceId, t.sentAt),
  ],
);

export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    spaceId: uuid("space_id").notNull().references(() => spaces.id),
    title: text("title").notNull(),
    assigneePersonId: uuid("assignee_person_id").references(() => people.id),
    dueAt: timestamp("due_at", { withTimezone: true }),
    status: text("status").notNull().default("open"), // open | done | cancelled
    sourceTgMessageId: bigint("source_tg_message_id", { mode: "number" }),
    createdBy: text("created_by").notNull().default("agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    doneAt: timestamp("done_at", { withTimezone: true }),
  },
  (t) => [index("tasks_space_status").on(t.spaceId, t.status)],
);

export const reminders = pgTable(
  "reminders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    spaceId: uuid("space_id").notNull().references(() => spaces.id),
    fireAt: timestamp("fire_at", { withTimezone: true }).notNull(),
    text: text("text").notNull(),
    targetPersonId: uuid("target_person_id").references(() => people.id),
    taskId: uuid("task_id").references(() => tasks.id),
    status: text("status").notNull().default("pending"), // pending | sent | cancelled
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
  },
  (t) => [index("reminders_due").on(t.status, t.fireAt)],
);

// Notes the agent writes for itself. spaceId null = global owner-level memory.
export const memories = pgTable(
  "memories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    spaceId: uuid("space_id").references(() => spaces.id),
    kind: text("kind").notNull().default("fact"), // fact | decision | preference | person | plan
    content: text("content").notNull(),
    personId: uuid("person_id").references(() => people.id),
    sourceTgMessageId: bigint("source_tg_message_id", { mode: "number" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
  },
  (t) => [index("memories_space").on(t.spaceId)],
);

// Telegram may redeliver updates; this makes the webhook idempotent.
export const processedUpdates = pgTable(
  "processed_updates",
  {
    botId: text("bot_id").notNull(),
    updateId: bigint("update_id", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.botId, t.updateId] })],
);

// Audit log of every agent invocation (visible in the admin UI later).
export const agentRuns = pgTable("agent_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  spaceId: uuid("space_id").references(() => spaces.id),
  trigger: text("trigger").notNull(), // mention | reply | command | cron
  input: text("input"),
  output: text("output"),
  toolCalls: jsonb("tool_calls").$type<unknown[]>(),
  usage: jsonb("usage").$type<Record<string, unknown>>(),
  model: text("model"),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// OAuth credentials for external integrations (Granola MCP and friends).
// Secrets only — never read into agent context or memory.
export const integrations = pgTable(
  "integrations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: text("provider").notNull(), // granola
    clientId: text("client_id").notNull(),
    accessToken: text("access_token").notNull(),
    refreshToken: text("refresh_token"),
    scope: text("scope"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("integrations_provider").on(t.provider)],
);

# Crew — платформа личных ассистентов в Telegram (часть семейства Sidekick)

Один движок, N Telegram-идентичностей («персон»). Каждый чат = **Space**: профиль, шаблон, память,
задачи, напоминания, журнал сообщений. Бот один и тот же везде, разницу между чатами делает Space.
Владелец: {OWNER}. Язык общения в чатах обычно русский.

## Стек
Next.js 16 (App Router, `src/`), grammY, Drizzle ORM + Neon Postgres, `@anthropic-ai/sdk` (beta tool runner, Zod),
Vercel (проект `crew`, прод: https://<project>.vercel.app, Neon `crew-db` подключён через marketplace).

## Карта кода
- `src/db/schema.ts` — spaces, people, space_members, messages (append-only журнал), tasks, reminders,
  memories (space_id null = глобальная память владельца), processed_updates (дедуп update_id), agent_runs (лог).
- `src/db/extra.sql` — GIN-индекс полнотекстового поиска по messages (`npm run db:extra`).
- `src/lib/bots.ts` — реестр персон: id → env с токеном + системный промпт. Первая персона `crew` (username @sk_crew_bot).
- `src/lib/telegram.ts` — кэш grammY-ботов, детект обращения (mention / reply / ЛС), отправка.
- `src/lib/ingest.ts` — upsert space/person/member, запись сообщения, дедуп апдейтов.
- `src/lib/context.ts` — сборка контекста Space текстом: участники, открытые задачи, память, последние 40 сообщений.
- `src/lib/agent.ts` — `runAgent()`: claude-opus-5-5, effort medium, `fallbacks: "default"`, кэшируемая персона в system,
  инструменты create_task / complete_task / set_reminder / save_memory / search_messages. Все инструменты
  прошиты на `space.id` в замыкании — модель никогда не передаёт space_id сама.
- `src/app/api/telegram/[botId]/route.ts` — webhook: проверка секрета, мгновенный 200, обработка в `waitUntil`.
  Команды `/id`, `/setup kind=.. tz=.. persona=".."` (только владелец), `/status`, `/ask`.
- `src/app/api/cron/tick/route.ts` — отправка созревших напоминаний (Vercel Cron `* * * * *`, см. vercel.json).
- `scripts/set-webhook.ts` — `npm run webhook:set -- crew` (нужны APP_URL и токен в .env.local).

## Env (см. .env.example)
DATABASE_URL (ставит Neon), TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, ANTHROPIC_API_KEY, OWNER_TG_USER_ID, CRON_SECRET, APP_URL.
Секреты только в `.env.local` и Vercel env. Никогда не печатать значения и не класть в код.

## Правила
- Инструменты агента всегда скоупятся по space_id в коде. Данные одного чата не должны попадать в другой.
- Журнал messages только дописывается. Бот не видит историю до своего добавления в чат.
- Ответы в Telegram — plain text без markdown.
- Стабильный системный префикс (персона) идёт первым и кэшируется; всё волатильное — после.
- Новые миграции: правим schema.ts → `set -a && source .env.local && set +a && npx drizzle-kit push`.

## Статус (2026-10-13)
Прод поднят и проверен сквозь все слои. Бот @sk_crew_bot (id <bot-id>), privacy выключен
(`can_read_all_group_messages: true`). Все 6 переменных лежат в Vercel для production/preview/development
(токены и ключи — как Secret, `APP_URL` и `OWNER_TG_USER_ID` — как Config). Webhook стоит на
`https://<project>.vercel.app/api/telegram/crew`, ошибок доставки нет. `/api/cron/tick` отвечает
`200 {"due":0,"sent":0}` с верным Bearer и `403` с неверным — то есть и Neon, и cron-авторизация работают.
Владелец: tg user id <owner-id>, `is_owner` в базе проставлен. Space созданы два (личка и тестовая группа
«Crew_bot_group», chat id <chat-id>), у обоих `timezone = America/Sao_Paulo`.

Защита деплоя: Vercel Authentication висит на direct-URL каждого деплоя (302 на sso-api), прод-алиас открыт.
Поэтому `APP_URL` должен указывать именно на алиас `<project>.vercel.app`, иначе Telegram упрётся в SSO.

Не проверено: агент ни разу не вызывался (`agent_runs = 0`), значит `ANTHROPIC_API_KEY` в проде вживую не
подтверждён; задач, напоминаний и памяти в базе пока нет.

Известная слабость: `set_reminder` делает `new Date(fire_at)`, а модель отдаёт ISO строкой. Если она
пропустит смещение, время будет разобрано как UTC (рантайм Vercel), и напоминание уедет на 3 часа.
Подтверждение тоже печатается в UTC через `toISOString()`. Стоит привязать разбор к `space.timezone`.

Прочее: `scripts/set-webhook.ts` импортирует `../src/lib/bots.ts` с расширением (Node 26 ESM требует его),
из-за чего в `tsconfig.json` включён `allowImportingTsExtensions`. `vercel env pull` не запускать —
перезапишет `.env.local` и потеряет секреты, добавленные руками.

## План дальше
1. Проверить живой цикл в тестовой группе; отладить триггеры и формат ответов.
2. Пассивная классификация каждого сообщения (claude-haiku-5-5): задача / договорённость / файл / шум → авто-запись в tasks/memories.
3. Скользящее `spaces.summary` и еженедельный дайджест по cron; заметки о людях.
4. Шаблоны Space (mentoring / client / team) как JSON в базе; вторая персона (пингер vs аналитик).
5. Файлы чата → Vercel Blob + извлечение текста + индекс; эмбеддинги (pgvector) при необходимости.
6. Админка на Next.js: список Space, шаблоны, лог agent_runs.

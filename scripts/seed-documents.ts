// Seed a space from a local folder: .md/.txt files become knowledge documents;
// an optional `_persona.md` becomes the space's persona (template=project, extract=on).
// Usage: node --env-file=.env.local scripts/seed-documents.ts <tg_chat_id> <folder> [--replace]
// Files are read from disk only; nothing from the folder is committed to the repo.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { neon } from "@neondatabase/serverless";

const [chatIdArg, folder, flag] = process.argv.slice(2);
if (!chatIdArg || !folder) throw new Error("usage: seed-documents.ts <tg_chat_id> <folder> [--replace]");
const sql = neon(process.env.DATABASE_URL!);

const spaces = await sql`select id, title from spaces where tg_chat_id = ${Number(chatIdArg)}`;
if (!spaces.length) throw new Error(`no space for chat ${chatIdArg}; add the bot to the chat and send /setup first`);
const space = spaces[0];
console.log(`space: ${space.title} (${space.id})`);

if (flag === "--replace") {
  await sql`delete from documents where space_id = ${space.id} and source like 'seed:%'`;
}

const personaPath = join(folder, "_persona.md");
try {
  const persona = readFileSync(personaPath, "utf8").trim();
  const cur = (await sql`select template, kind from spaces where id = ${space.id}`)[0];
  const template = { ...(cur.template ?? {}), persona, template: "project", extract: true };
  await sql`update spaces set kind = 'project', template = ${JSON.stringify(template)}::jsonb where id = ${space.id}`;
  console.log(`persona set (${persona.length} chars), template=project, extract=on`);
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const files = walk(folder).filter((f) => [".md", ".txt"].includes(extname(f).toLowerCase()) && basename(f) !== "_persona.md");
for (const f of files) {
  const content = readFileSync(f, "utf8");
  if (content.trim().length < 50) continue;
  const title = basename(f).replace(/\.(md|txt)$/i, "").replace(/[_-]+/g, " ");
  await sql`insert into documents (space_id, title, content, source) values (${space.id}, ${title}, ${content}, ${"seed:" + basename(f)})`;
  console.log(`+ ${title} (${content.length})`);
}
console.log(`done: ${files.length} files`);

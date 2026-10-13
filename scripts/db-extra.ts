import { readFileSync } from "node:fs";
import { neon } from "@neondatabase/serverless";

const sql = neon(process.env.DATABASE_URL!);
const statements = readFileSync("src/db/extra.sql", "utf8")
  .split(";")
  .map((s) => s.trim())
  .filter((s) => s && !s.startsWith("--"));
for (const s of statements) {
  await sql.query(s);
  console.log("ok:", s.split("\n")[0]);
}

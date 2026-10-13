// One-time Granola MCP authorisation via the OAuth device flow.
// Usage: npm run granola:auth
//
// Device flow needs no redirect URI and no public callback: you open a URL,
// approve, and this polls for the token. Tokens land in the integrations table;
// the bot refreshes them on its own afterwards.
import { neon } from "@neondatabase/serverless";

const AUTH = "https://mcp-auth.granola.ai";
const RESOURCE = "https://mcp.granola.ai/mcp";
const SCOPE = "mcp offline_access";

const sql = neon(process.env.DATABASE_URL!);

async function registerClient(): Promise<string> {
  const res = await fetch(`${AUTH}/oauth2/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Crew Telegram assistant",
      // Required by the server even though the device flow never redirects.
      redirect_uris: [`${process.env.APP_URL ?? "https://example.invalid"}/api/granola/callback`],
      grant_types: ["authorization_code", "refresh_token", "urn:ietf:params:oauth:grant-type:device_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      application_type: "web",
      scope: `${SCOPE} openid email`,
    }),
  });
  const j = (await res.json()) as { client_id?: string; error_description?: string };
  if (!j.client_id) throw new Error(`registration failed: ${j.error_description ?? JSON.stringify(j)}`);
  return j.client_id;
}

async function main() {
  const existing = await sql`select client_id from integrations where provider = 'granola' limit 1`;
  const clientId = process.env.GRANOLA_CLIENT_ID || existing[0]?.client_id || (await registerClient());
  console.log(`client_id: ${clientId}`);

  const devRes = await fetch(`${AUTH}/oauth2/device_authorization`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, scope: SCOPE, resource: RESOURCE }),
  });
  const dev = (await devRes.json()) as {
    device_code?: string;
    user_code?: string;
    verification_uri_complete?: string;
    verification_uri?: string;
    expires_in?: number;
    interval?: number;
    error_description?: string;
  };
  if (!dev.device_code) throw new Error(`device authorization failed: ${dev.error_description ?? JSON.stringify(dev)}`);

  console.log("\nОткрой и подтверди доступ:");
  console.log(`  ${dev.verification_uri_complete ?? dev.verification_uri}`);
  console.log(`  код: ${dev.user_code}   (действует ${dev.expires_in ?? "?"} с)\n`);

  const interval = (dev.interval ?? 5) * 1000;
  const deadline = Date.now() + (dev.expires_in ?? 300) * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval));
    const res = await fetch(`${AUTH}/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: dev.device_code,
        client_id: clientId,
      }),
    });
    const j = (await res.json()) as {
      access_token?: string;
      refresh_token?: string;
      scope?: string;
      expires_in?: number;
      error?: string;
    };
    if (j.access_token) {
      const expiresAt = j.expires_in ? new Date(Date.now() + j.expires_in * 1000) : null;
      await sql`
        insert into integrations (provider, client_id, access_token, refresh_token, scope, expires_at)
        values ('granola', ${clientId}, ${j.access_token}, ${j.refresh_token ?? null}, ${j.scope ?? null}, ${expiresAt})
        on conflict (provider) do update set
          client_id = excluded.client_id,
          access_token = excluded.access_token,
          refresh_token = excluded.refresh_token,
          scope = excluded.scope,
          expires_at = excluded.expires_at,
          updated_at = now()`;
      console.log("Готово. Токен сохранён в integrations.");
      console.log(`  scope: ${j.scope ?? "-"}`);
      console.log(`  истекает: ${expiresAt ? expiresAt.toISOString() : "не указано"}`);
      console.log(`  refresh_token: ${j.refresh_token ? "есть" : "НЕТ — переподключать придётся руками"}`);
      return;
    }
    if (j.error && j.error !== "authorization_pending" && j.error !== "slow_down") {
      throw new Error(`token exchange failed: ${j.error}`);
    }
    process.stdout.write(".");
  }
  throw new Error("device code expired before approval");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

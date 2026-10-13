// Granola's hosted MCP server, reached with an OAuth token we hold ourselves.
// The Messages API MCP connector does not refresh tokens (that is a Managed
// Agents feature), so refreshing is our job.
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";

export const GRANOLA_MCP_URL = "https://mcp.granola.ai/mcp";
export const GRANOLA_AUTH_SERVER = "https://mcp-auth.granola.ai";
export const GRANOLA_TOKEN_ENDPOINT = `${GRANOLA_AUTH_SERVER}/oauth2/token`;
export const GRANOLA_DEVICE_ENDPOINT = `${GRANOLA_AUTH_SERVER}/oauth2/device_authorization`;
export const GRANOLA_REGISTER_ENDPOINT = `${GRANOLA_AUTH_SERVER}/oauth2/register`;

const PROVIDER = "granola";
// Refresh a little early so a request never races the expiry.
const REFRESH_SKEW_MS = 60_000;

export type TokenSet = {
  clientId: string;
  accessToken: string;
  refreshToken?: string | null;
  scope?: string | null;
  expiresIn?: number | null;
};

export async function saveGranolaTokens(t: TokenSet) {
  const expiresAt = t.expiresIn ? new Date(Date.now() + t.expiresIn * 1000) : null;
  await db
    .insert(schema.integrations)
    .values({
      provider: PROVIDER,
      clientId: t.clientId,
      accessToken: t.accessToken,
      refreshToken: t.refreshToken ?? null,
      scope: t.scope ?? null,
      expiresAt,
    })
    .onConflictDoUpdate({
      target: schema.integrations.provider,
      set: {
        clientId: t.clientId,
        accessToken: t.accessToken,
        refreshToken: t.refreshToken ?? null,
        scope: t.scope ?? null,
        expiresAt,
        updatedAt: new Date(),
      },
    });
}

export async function exchangeRefreshToken(clientId: string, refreshToken: string): Promise<TokenSet | null> {
  const res = await fetch(GRANOLA_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      resource: GRANOLA_MCP_URL,
    }),
  });
  if (!res.ok) {
    console.error("granola refresh failed", res.status, (await res.text()).slice(0, 200));
    return null;
  }
  const j = (await res.json()) as Record<string, unknown>;
  const accessToken = typeof j.access_token === "string" ? j.access_token : null;
  if (!accessToken) return null;
  return {
    clientId,
    accessToken,
    // Rotating servers return a new refresh token; keep the old one otherwise.
    refreshToken: typeof j.refresh_token === "string" ? j.refresh_token : refreshToken,
    scope: typeof j.scope === "string" ? j.scope : null,
    expiresIn: typeof j.expires_in === "number" ? j.expires_in : null,
  };
}

// Returns a usable access token, refreshing if needed. Null means "integration
// not connected or broken" — callers must degrade quietly, never fail the reply.
export async function getGranolaToken(): Promise<string | null> {
  const row = await db.query.integrations.findFirst({
    where: (t, { eq: is }) => is(t.provider, PROVIDER),
  });
  if (!row) return null;

  const stillValid = !row.expiresAt || row.expiresAt.getTime() - Date.now() > REFRESH_SKEW_MS;
  if (stillValid) return row.accessToken;
  if (!row.refreshToken) return null;

  const next = await exchangeRefreshToken(row.clientId, row.refreshToken);
  if (!next) return null;
  await saveGranolaTokens(next);
  return next.accessToken;
}

export async function clearGranolaTokens() {
  await db.delete(schema.integrations).where(eq(schema.integrations.provider, PROVIDER));
}

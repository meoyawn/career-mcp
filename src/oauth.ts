import * as v from "valibot";
import { authError, getSessionUser, hashToken, nowSeconds, randomToken, readBody, readJson, requireOrigin } from "./auth.ts";
import { signInPage } from "./sign-in-page.ts";

const registrationSchema = v.object({
  client_name: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(100)), "MCP client"),
  redirect_uris: v.pipe(v.array(v.pipe(v.string(), v.maxLength(2048))), v.minLength(1), v.maxLength(10)),
  token_endpoint_auth_method: v.optional(v.literal("none"), "none"),
  grant_types: v.optional(v.array(v.picklist(["authorization_code", "refresh_token"]))),
  response_types: v.optional(v.array(v.literal("code"))),
});
const authorizationSchema = v.object({
  client_id: v.string(), redirect_uri: v.string(), response_type: v.literal("code"),
  code_challenge: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{43}$/u)), code_challenge_method: v.literal("S256"),
  state: v.optional(v.pipe(v.string(), v.maxLength(2048))),
  scope: v.optional(v.literal("careers"), "careers"), resource: v.optional(v.string()),
});
interface OAuthClient {
  id: string;
  name: string;
  redirect_uris: string;
}

function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" } });
}

function validateRedirect(uri: string) {
  let url;
  try { url = new URL(uri); } catch { authError("Invalid redirect URI"); }
  if (url.hash || url.username || url.password ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) {
    authError("Redirect URIs must use HTTPS or a localhost HTTP callback");
  }
}

async function authorization(db: D1Database, params: unknown, origin: string) {
  const input = v.parse(authorizationSchema, params);
  if (input.resource !== undefined && input.resource !== `${origin}/mcp`) authError("Invalid resource");
  const client = await db.prepare("SELECT * FROM oauth_clients WHERE id IS ?").bind(input.client_id).first<OAuthClient>();
  if (!client || !v.parse(v.array(v.string()), JSON.parse(client.redirect_uris)).includes(input.redirect_uri)) authError("Invalid client or redirect URI");
  return { input, client };
}

export async function getMcpUser(request: Request, db: D1Database) {
  const match = request.headers.get("Authorization")?.match(/^Bearer ([A-Za-z0-9_-]{43})$/iu);
  if (!match?.[1]) return null;
  const token = await db.prepare(`SELECT user_id FROM oauth_tokens
    WHERE access_hash IS ? AND resource IS ? AND access_expires_at > ?`)
    .bind(await hashToken(match[1]), `${new URL(request.url).origin}/mcp`, nowSeconds()).first<{ user_id: string }>();
  return token?.user_id ?? null;
}

async function exchange(request: Request, db: D1Database, origin: string) {
  if (!request.headers.get("Content-Type")?.startsWith("application/x-www-form-urlencoded")) authError("Use a form-encoded token request");
  const input = new URLSearchParams(await readBody(request));
  const clientId = input.get("client_id") ?? "";
  const resource = input.get("resource") ?? `${origin}/mcp`;
  if (resource !== `${origin}/mcp`) return json({ error: "invalid_target" }, 400);
  const access = randomToken();
  const refresh = randomToken();
  const now = nowSeconds();
  let source: "oauth_codes" | "oauth_tokens";
  let where: string;
  let bindings: (string | number)[];
  if (input.get("grant_type") === "authorization_code") {
    const verifier = input.get("code_verifier") ?? "";
    if (!/^[A-Za-z0-9._~-]{43,128}$/u.test(verifier)) return json({ error: "invalid_grant" }, 400);
    source = "oauth_codes";
    where = "code_hash IS ? AND client_id IS ? AND redirect_uri IS ? AND resource IS ? AND code_challenge IS ? AND expires_at > ?";
    bindings = [await hashToken(input.get("code") ?? ""), clientId, input.get("redirect_uri") ?? "", resource, await hashToken(verifier), now];
  } else if (input.get("grant_type") === "refresh_token") {
    source = "oauth_tokens";
    where = "refresh_hash IS ? AND client_id IS ? AND resource IS ? AND refresh_expires_at > ?";
    bindings = [await hashToken(input.get("refresh_token") ?? ""), clientId, resource, now];
  } else {
    return json({ error: "unsupported_grant_type" }, 400);
  }
  const results = await db.batch([
    db.prepare(`INSERT INTO oauth_tokens (access_hash, refresh_hash, user_id, client_id, resource, access_expires_at, refresh_expires_at)
      SELECT ?, ?, user_id, client_id, resource, ?, ? FROM ${source} WHERE ${where} RETURNING user_id`)
      .bind(await hashToken(access), await hashToken(refresh), now + 3600, now + 2_592_000, ...bindings),
    db.prepare(`DELETE FROM ${source} WHERE ${where}`).bind(...bindings),
    db.prepare("DELETE FROM oauth_tokens WHERE refresh_expires_at <= ?").bind(now),
  ]);
  if (results[0]?.results.length !== 1) return json({ error: "invalid_grant" }, 400);
  return json({ access_token: access, token_type: "Bearer", expires_in: 3600, refresh_token: refresh, scope: "careers" });
}

export async function oauthRoutes(request: Request, db: D1Database) {
  const url = new URL(request.url);
  const origin = url.origin;
  const discovery = url.pathname.startsWith("/.well-known/");
  const publicEndpoint = discovery || ["/oauth/register", "/oauth/token", "/oauth/revoke"].includes(url.pathname);
  if (publicEndpoint && request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: {
      "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    } });
  }
  if (request.method === "GET" && ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"].includes(url.pathname)) {
    return json({ resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: ["careers"], bearer_methods_supported: ["header"] });
  }
  if (request.method === "GET" && url.pathname === "/.well-known/oauth-authorization-server") {
    return json({
      issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/oauth/token`,
      registration_endpoint: `${origin}/oauth/register`, revocation_endpoint: `${origin}/oauth/revoke`,
      response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"], revocation_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"], scopes_supported: ["careers"],
    });
  }
  if (request.method === "POST" && url.pathname === "/oauth/register") {
    const input = v.parse(registrationSchema, await readJson(request));
    for (const uri of input.redirect_uris) validateRedirect(uri);
    const id = crypto.randomUUID();
    await db.prepare("INSERT INTO oauth_clients (id, name, redirect_uris, created_at) VALUES (?, ?, ?, ?)")
      .bind(id, input.client_name, JSON.stringify(input.redirect_uris), new Date().toISOString()).run();
    return json({
      client_id: id, client_name: input.client_name, redirect_uris: input.redirect_uris,
      token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
    }, 201);
  }
  if (request.method === "POST" && url.pathname === "/oauth/token") return exchange(request, db, origin);
  if (request.method === "POST" && url.pathname === "/oauth/revoke") {
    const input = new URLSearchParams(await readBody(request));
    const hash = await hashToken(input.get("token") ?? "");
    await db.prepare("DELETE FROM oauth_tokens WHERE client_id IS ? AND (access_hash IS ? OR refresh_hash IS ?)")
      .bind(input.get("client_id") ?? "", hash, hash).run();
    return json({});
  }
  if (request.method === "GET" && url.pathname === "/authorize") {
    const { input, client } = await authorization(db, Object.fromEntries(url.searchParams), origin);
    return signInPage(await getSessionUser(request, db), { input, clientName: client.name, callbackHost: new URL(input.redirect_uri).host });
  }
  if (request.method === "POST" && url.pathname === "/authorize/finish") {
    requireOrigin(request);
    const body = v.parse(v.object({ request: v.unknown(), allow: v.boolean() }), await readJson(request));
    const { input } = await authorization(db, body.request, origin);
    const redirect = new URL(input.redirect_uri);
    if (input.state !== undefined) redirect.searchParams.set("state", input.state);
    if (!body.allow) {
      redirect.searchParams.set("error", "access_denied");
      return Response.json({ redirect: redirect.href });
    }
    const userId = await getSessionUser(request, db);
    if (!userId) authError("Sign in with a passkey first", 401);
    const code = randomToken();
    await db.batch([
      db.prepare("DELETE FROM oauth_codes WHERE expires_at <= ?").bind(nowSeconds()),
      db.prepare(`INSERT INTO oauth_codes (code_hash, user_id, client_id, redirect_uri, code_challenge, resource, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .bind(await hashToken(code), userId, input.client_id, input.redirect_uri, input.code_challenge, `${origin}/mcp`, nowSeconds() + 60),
    ]);
    redirect.searchParams.set("code", code);
    return Response.json({ redirect: redirect.href });
  }
  if (request.method === "GET" && url.pathname === "/") return signInPage(await getSessionUser(request, db), null);
  return null;
}

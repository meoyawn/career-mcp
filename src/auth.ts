import {
  generateAuthenticationOptions, generateRegistrationOptions,
  verifyAuthenticationResponse, verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { Buffer } from "node:buffer";
import * as v from "valibot";

const credentialFields = {
  id: v.string(), rawId: v.string(), type: v.literal("public-key"),
  clientExtensionResults: v.looseObject({}),
};
const registrationSchema = v.object({
  ...credentialFields,
  response: v.object({ clientDataJSON: v.string(), attestationObject: v.string() }),
});
const authenticationSchema = v.object({
  ...credentialFields,
  response: v.object({
    clientDataJSON: v.string(), authenticatorData: v.string(), signature: v.string(),
    userHandle: v.string(),
  }),
});

interface Challenge {
  challenge: string;
  user_id: string | null;
}

export const randomToken = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
export const nowSeconds = () => Math.floor(Date.now() / 1000);

export async function hashToken(token: string) {
  return Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))).toString("base64url");
}

export function authError(message: string, status = 400): never {
  throw new Error(message, { cause: status });
}

export function requireOrigin(request: Request) {
  if (request.headers.get("Origin") !== new URL(request.url).origin) authError("Origin not allowed", 403);
}

export async function readBody(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let size = 0;
  let body = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return body + decoder.decode();
      size += chunk.value.byteLength;
      if (size > 65_536) {
        await reader.cancel();
        authError("Request body too large", 413);
      }
      body += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

export async function readJson(request: Request): Promise<unknown> {
  try {
    return JSON.parse(await readBody(request));
  } catch (error) {
    if (error instanceof SyntaxError) authError("Invalid JSON");
    throw error;
  }
}

function cookieValue(request: Request, name: string) {
  return request.headers.get("Cookie")?.split(";").map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1) ?? "";
}

function cookie(request: Request, name: string, value: string, age: number, path: string) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${name}=${value}; Path=${path}; Max-Age=${age}; HttpOnly; SameSite=Lax${secure}`;
}

export async function getSessionUser(request: Request, db: D1Database) {
  const token = cookieValue(request, "careers_session");
  if (!token) return null;
  const session = await db.prepare("SELECT user_id FROM browser_sessions WHERE token_hash IS ? AND expires_at > ?")
    .bind(await hashToken(token), nowSeconds()).first<{ user_id: string }>();
  return session?.user_id ?? null;
}

async function newSession(request: Request, db: D1Database, userId: string) {
  const token = randomToken();
  const oldHash = await hashToken(cookieValue(request, "careers_session"));
  await db.batch([
    db.prepare("DELETE FROM browser_sessions WHERE token_hash IS ? OR expires_at <= ?").bind(oldHash, nowSeconds()),
    db.prepare("INSERT INTO browser_sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
      .bind(await hashToken(token), userId, nowSeconds() + 604_800),
  ]);
  const headers = new Headers();
  headers.append("Set-Cookie", cookie(request, "careers_session", token, 604_800, "/"));
  headers.append("Set-Cookie", cookie(request, "careers_challenge", "", 0, "/auth"));
  return Response.json({ ok: true }, { headers });
}

async function saveChallenge(request: Request, db: D1Database, challenge: string, kind: string, userId: string | null) {
  const token = randomToken();
  await db.batch([
    db.prepare("DELETE FROM auth_challenges WHERE expires_at <= ? OR id_hash IS ?")
      .bind(nowSeconds(), await hashToken(cookieValue(request, "careers_challenge"))),
    db.prepare("INSERT INTO auth_challenges (id_hash, challenge, kind, user_id, expires_at) VALUES (?, ?, ?, ?, ?)")
      .bind(await hashToken(token), challenge, kind, userId, nowSeconds() + 300),
  ]);
  return { "Set-Cookie": cookie(request, "careers_challenge", token, 300, "/auth") };
}

async function consumeChallenge(request: Request, db: D1Database, kind: string) {
  const token = cookieValue(request, "careers_challenge");
  if (!token) authError("Start passkey sign-in again", 401);
  const challenge = await db.prepare(`DELETE FROM auth_challenges
    WHERE id_hash IS ? AND kind IS ? AND expires_at > ? RETURNING challenge, user_id`)
    .bind(await hashToken(token), kind, nowSeconds()).first<Challenge>();
  if (!challenge) authError("Passkey challenge expired or already used", 401);
  return challenge;
}

export async function authRoutes(request: Request, db: D1Database) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/auth/")) return null;
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
  requireOrigin(request);
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname)) authError("Passkeys require HTTPS", 400);

  if (url.pathname === "/auth/register/options") {
    const userId = await getSessionUser(request, db) ?? crypto.randomUUID();
    const existing = await db.prepare("SELECT id FROM passkeys WHERE user_id IS ?").bind(userId).all<{ id: string }>();
    const options = await generateRegistrationOptions({
      rpName: "Careers", rpID: url.hostname,
      userName: `Careers ${userId.slice(0, 8)}`, userDisplayName: `Careers ${userId.slice(0, 8)}`,
      userID: new Uint8Array(new TextEncoder().encode(userId)),
      attestationType: "none", excludeCredentials: existing.results,
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
      supportedAlgorithmIDs: [-7, -257],
    });
    return Response.json(options, { headers: await saveChallenge(request, db, options.challenge, "register", userId) });
  }
  if (url.pathname === "/auth/register/verify") {
    const challenge = await consumeChallenge(request, db, "register");
    const response = v.parse(registrationSchema, await readJson(request));
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response, expectedChallenge: challenge.challenge, expectedOrigin: url.origin,
        expectedRPID: url.hostname, requireUserVerification: true, supportedAlgorithmIDs: [-7, -257],
      });
    } catch {
      authError("Passkey verification failed", 401);
    }
    if (!verification.verified || !challenge.user_id) authError("Passkey verification failed", 401);
    const { credential } = verification.registrationInfo;
    const userId = challenge.user_id;
    const exists = await db.prepare("SELECT id FROM users WHERE id IS ?").bind(userId).first();
    if (exists && await getSessionUser(request, db) !== userId) authError("Sign in before adding another passkey", 401);
    const statements = [];
    if (!exists) statements.push(db.prepare("INSERT INTO users (id, created_at) VALUES (?, ?)").bind(userId, new Date().toISOString()));
    statements.push(db.prepare("INSERT INTO passkeys (id, user_id, public_key, counter, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(credential.id, userId, Buffer.from(credential.publicKey).toString("base64url"), credential.counter, new Date().toISOString()));
    await db.batch(statements);
    return newSession(request, db, userId);
  }
  if (url.pathname === "/auth/login/options") {
    const options = await generateAuthenticationOptions({ rpID: url.hostname, userVerification: "required" });
    return Response.json(options, { headers: await saveChallenge(request, db, options.challenge, "login", null) });
  }
  if (url.pathname === "/auth/login/verify") {
    const challenge = await consumeChallenge(request, db, "login");
    const response = v.parse(authenticationSchema, await readJson(request));
    const passkey = await db.prepare("SELECT * FROM passkeys WHERE id IS ?").bind(response.id)
      .first<{ id: string; user_id: string; public_key: string; counter: number }>();
    if (!passkey || response.response.userHandle !== Buffer.from(passkey.user_id).toString("base64url")) authError("Passkey verification failed", 401);
    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response, expectedChallenge: challenge.challenge, expectedOrigin: url.origin,
        expectedRPID: url.hostname, requireUserVerification: true,
        credential: { id: passkey.id, publicKey: new Uint8Array(Buffer.from(passkey.public_key, "base64url")), counter: passkey.counter },
      });
    } catch {
      authError("Passkey verification failed", 401);
    }
    if (!verification.verified) authError("Passkey verification failed", 401);
    const updated = await db.prepare("UPDATE passkeys SET counter = ? WHERE id IS ? AND counter IS ? RETURNING id")
      .bind(verification.authenticationInfo.newCounter, passkey.id, passkey.counter).first();
    if (!updated) authError("Passkey was used concurrently. Sign in again.", 401);
    return newSession(request, db, passkey.user_id);
  }
  if (url.pathname === "/auth/logout") {
    await db.prepare("DELETE FROM browser_sessions WHERE token_hash IS ?")
      .bind(await hashToken(cookieValue(request, "careers_session"))).run();
    return Response.json({ ok: true }, { headers: { "Set-Cookie": cookie(request, "careers_session", "", 0, "/") } });
  }
  if (url.pathname === "/auth/revoke") {
    const userId = await getSessionUser(request, db);
    if (!userId) authError("Sign in first", 401);
    await db.batch([
      db.prepare("DELETE FROM oauth_tokens WHERE user_id IS ?").bind(userId),
      db.prepare("DELETE FROM oauth_codes WHERE user_id IS ?").bind(userId),
    ]);
    return Response.json({ ok: true });
  }
  return new Response("Not found", { status: 404 });
}

import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { encodeCBOR, type CBORType } from "@levischuck/tiny-cbor";
import * as v from "valibot";

export function browserFor(endpoint: URL) {
  const cookies = new Map<string, string>();
  async function request(path: string, body?: unknown) {
    const response = await fetch(new URL(path, endpoint), {
      method: body === undefined ? "GET" : "POST",
      headers: { Origin: endpoint.origin, Cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join("; "), "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    for (const header of response.headers.getSetCookie()) {
      const pair = header.split(";")[0] ?? "";
      const split = pair.indexOf("=");
      cookies.set(pair.slice(0, split), pair.slice(split + 1));
    }
    return response;
  }
  return { origin: endpoint.origin, cookies, request };
}

interface Passkey {
  id: Buffer;
  privateKey: KeyObject;
  userHandle: string;
  rpId: string;
  counter: number;
}

const registrationOptionsSchema = v.object({ challenge: v.string(), user: v.object({ id: v.string() }), rp: v.object({ id: v.string() }) });
const authenticationOptionsSchema = v.object({ challenge: v.string(), rpId: v.string() });

export async function enroll(browser: ReturnType<typeof browserFor>) {
  const optionsResponse = await browser.request("/auth/register/options", {});
  assert.equal(optionsResponse.status, 200);
  const options = v.parse(registrationOptionsSchema, await optionsResponse.json());
  const challengeCookie = browser.cookies.get("careers_challenge");
  assert.ok(challengeCookie);
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  assert.ok(jwk.x && jwk.y);
  const passkey: Passkey = { id: randomBytes(32), privateKey, userHandle: options.user.id, rpId: options.rp.id, counter: 0 };
  const coseKey = encodeCBOR(new Map<number, CBORType>([
    [1, 2], [3, -7], [-1, 1], [-2, new Uint8Array(Buffer.from(jwk.x, "base64url"))], [-3, new Uint8Array(Buffer.from(jwk.y, "base64url"))],
  ]));
  const length = Buffer.alloc(2);
  length.writeUInt16BE(passkey.id.length);
  const authData = Buffer.concat([
    createHash("sha256").update(passkey.rpId).digest(), Buffer.from([0x45]), Buffer.alloc(4),
    Buffer.alloc(16), length, passkey.id, coseKey,
  ]);
  const attestationObject = encodeCBOR(new Map<string, CBORType>([
    ["fmt", "none"], ["attStmt", new Map()], ["authData", new Uint8Array(authData)],
  ]));
  const response = {
    id: passkey.id.toString("base64url"), rawId: passkey.id.toString("base64url"), type: "public-key", clientExtensionResults: {},
    response: {
      clientDataJSON: Buffer.from(JSON.stringify({ type: "webauthn.create", challenge: options.challenge, origin: browser.origin, crossOrigin: false })).toString("base64url"),
      attestationObject: Buffer.from(attestationObject).toString("base64url"),
    },
  };
  const verified = await browser.request("/auth/register/verify", response);
  assert.equal(verified.status, 200, await verified.text());
  assert.ok(browser.cookies.get("careers_session"));
  return { passkey, response, challengeCookie };
}

export async function assertion(browser: ReturnType<typeof browserFor>, passkey: Passkey) {
  const optionsResponse = await browser.request("/auth/login/options", {});
  assert.equal(optionsResponse.status, 200);
  const options = v.parse(authenticationOptionsSchema, await optionsResponse.json());
  passkey.counter++;
  const count = Buffer.alloc(4);
  count.writeUInt32BE(passkey.counter);
  const authenticatorData = Buffer.concat([createHash("sha256").update(options.rpId).digest(), Buffer.from([0x05]), count]);
  const clientData = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: options.challenge, origin: browser.origin, crossOrigin: false }));
  const signature = sign("sha256", Buffer.concat([authenticatorData, createHash("sha256").update(clientData).digest()]), passkey.privateKey);
  return {
    id: passkey.id.toString("base64url"), rawId: passkey.id.toString("base64url"), type: "public-key", clientExtensionResults: {},
    response: {
      clientDataJSON: clientData.toString("base64url"), authenticatorData: authenticatorData.toString("base64url"),
      signature: signature.toString("base64url"), userHandle: passkey.userHandle,
    },
  };
}

export async function authorize(browser: ReturnType<typeof browserFor>) {
  const clientResponse = await browser.request("/oauth/register", { client_name: "Workflow test", redirect_uris: ["https://client.example/callback"] });
  assert.equal(clientResponse.status, 201);
  const client = v.parse(v.object({ client_id: v.string() }), await clientResponse.json());
  const verifier = randomBytes(32).toString("base64url");
  const request = {
    client_id: client.client_id, redirect_uri: "https://client.example/callback", response_type: "code",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256",
    scope: "careers", state: randomBytes(16).toString("hex"), resource: `${browser.origin}/mcp`,
  };
  assert.equal((await browser.request(`/authorize?${new URLSearchParams(request)}`)).status, 200);
  const authorized = await browser.request("/authorize/finish", { request, allow: true });
  if (authorized.status !== 200) assert.fail(await authorized.text());
  const redirect = new URL(v.parse(v.object({ redirect: v.string() }), await authorized.json()).redirect);
  assert.equal(redirect.origin + redirect.pathname, request.redirect_uri);
  assert.equal(redirect.searchParams.get("state"), request.state);
  const code = redirect.searchParams.get("code");
  assert.ok(code);
  const tokenRequest = { grant_type: "authorization_code", client_id: request.client_id, redirect_uri: request.redirect_uri, code, code_verifier: verifier, resource: request.resource };
  const exchanged = await exchange(browser.origin, tokenRequest);
  assert.equal(exchanged.status, 200);
  const tokens = v.parse(v.object({ access_token: v.string(), refresh_token: v.string() }), await exchanged.json());
  return { token: tokens.access_token, refresh: tokens.refresh_token, clientId: client.client_id, request, tokenRequest };
}

export function exchange(origin: string, input: Record<string, string>) {
  return fetch(`${origin}/oauth/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(input) });
}

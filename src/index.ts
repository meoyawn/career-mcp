import { createMcpHandler } from "@modelcontextprotocol/server";
import { createServer } from "./server.ts";

async function authorized(request: Request, token: string) {
  const supplied = request.headers.get("Authorization") ?? "";
  const encoder = new TextEncoder();
  const [actual, expected] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(supplied)),
    crypto.subtle.digest("SHA-256", encoder.encode(`Bearer ${token}`)),
  ]);
  return crypto.subtle.timingSafeEqual(actual, expected);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") return Response.json({ ok: true });
    if (url.pathname !== "/mcp") return new Response("Not found", { status: 404 });
    if (!env.MCP_AUTH_TOKEN) return new Response("Configure MCP_AUTH_TOKEN before connecting.", { status: 503 });
    if (!await authorized(request, env.MCP_AUTH_TOKEN)) {
      return new Response("Unauthorized", { status: 401, headers: { "WWW-Authenticate": "Bearer" } });
    }
    const origin = request.headers.get("Origin");
    if (origin !== null && origin !== url.origin) return new Response("Origin not allowed", { status: 403 });
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });

    const handler = createMcpHandler(() => createServer(env.DB), { responseMode: "json", maxRequestBodySize: 1_048_576 });
    try {
      return await handler.fetch(request);
    } catch {
      console.error(JSON.stringify({ event: "request_failed" }));
      return new Response("Internal server error", { status: 500 });
    } finally {
      await handler.close();
    }
  },
} satisfies ExportedHandler<Env>;

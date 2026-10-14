import { createMcpHandler } from "@modelcontextprotocol/server";
import { ValiError } from "valibot";
import { authRoutes } from "./auth.ts";
import { getMcpUser, oauthRoutes } from "./oauth.ts";
import { createServer } from "./server.ts";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/health" && request.method === "GET") return Response.json({ ok: true });
      const response = await authRoutes(request, env.DB) ?? await oauthRoutes(request, env.DB);
      if (response) {
        response.headers.set("Cache-Control", "no-store");
        response.headers.set("X-Content-Type-Options", "nosniff");
        return response;
      }
      if (url.pathname !== "/mcp") return new Response("Not found", { status: 404 });
      const origin = request.headers.get("Origin");
      if (origin !== null && origin !== url.origin) return new Response("Origin not allowed", { status: 403 });
      const userId = await getMcpUser(request, env.DB);
      if (!userId) {
        return new Response("Unauthorized", { status: 401, headers: {
          "WWW-Authenticate": `Bearer resource_metadata="${url.origin}/.well-known/oauth-protected-resource/mcp", scope="careers"`,
          "Cache-Control": "no-store",
        } });
      }
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
      const handler = createMcpHandler(() => createServer(env.DB, userId), { responseMode: "json", maxRequestBodySize: 1_048_576 });
      try {
        return await handler.fetch(request);
      } finally {
        await handler.close();
      }
    } catch (error) {
      if (error instanceof ValiError || (error instanceof Error && typeof error.cause === "number")) {
        const status = error instanceof ValiError ? 400 : Number(error.cause);
        return Response.json({ error: "invalid_request", error_description: error.message }, { status, headers: { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" } });
      }
      console.error(JSON.stringify({ event: "request_failed" }));
      return new Response("Internal server error", { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;

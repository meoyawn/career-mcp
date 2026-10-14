import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { promisify } from "node:util";
import * as v from "valibot";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const wrangler = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));
const readQueryStart = /^(?:(?:\s+)|(?:--[^\r\n]*(?:\r?\n|$))|(?:\/\*[\s\S]*?\*\/))*(?:select|with)\b/iu;
const queryResultSchema = v.array(v.object({
  success: v.literal(true),
  results: v.array(v.record(v.string(), v.unknown())),
  meta: v.object({ changed_db: v.boolean(), rows_written: v.number() }),
}));

function normalizeReadQuery(sql: string) {
  const trimmed = sql.trim();
  if (!readQueryStart.test(trimmed)) throw new Error("Only SELECT queries and read-only CTEs are allowed.");
  const query = trimmed.endsWith(";") ? trimmed.slice(0, -1).trimEnd() : trimmed;
  if (query.includes(";")) throw new Error("Only one statement is allowed; semicolons within the query are unsupported.");
  return query;
}

async function main() {
  if (process.argv.length !== 3 || !process.argv[2]) throw new Error("Usage: node scripts/d1.ts '<sql>'");
  const sql = normalizeReadQuery(process.argv[2]);
  const deployEnv = new URL("../.env.deploy", import.meta.url);
  if (existsSync(deployEnv)) process.loadEnvFile(deployEnv);
  // A subquery only accepts a read, including when the input starts with WITH.
  const { stdout } = await execute(process.execPath, [wrangler, "d1", "execute", "careers", "--remote",
    "--config", fileURLToPath(new URL("../wrangler.jsonc", import.meta.url)),
    "--command", `SELECT * FROM (\n${sql}\n)`, "--json"], {
    cwd: root,
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    maxBuffer: 10 * 1024 * 1024,
  });
  const results = v.parse(queryResultSchema, JSON.parse(stdout));
  if (results.length !== 1 || !results[0]) throw new Error("D1 did not return one successful query result.");
  if (results[0].meta.changed_db || results[0].meta.rows_written !== 0) throw new Error("D1 reported an unexpected write from a read-only query.");
  console.log(JSON.stringify(results[0].results, null, 2));
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

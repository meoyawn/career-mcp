import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";

// Private deployment settings live outside the checkout. Wrangler resolves `main`
// and `migrations_dir` relative to its config file, so each remote command gets a
// temporary copy with absolute paths into this checkout.
export const root = fileURLToPath(new URL("../", import.meta.url));
export const wrangler = join(root, "node_modules/wrangler/bin/wrangler.js");
export const secretsDir = process.env.CAREER_MCP_SECRETS || join(homedir(), ".secrets/career-mcp");

export function remoteConfig() {
  const source = join(secretsDir, "wrangler.deploy.jsonc");
  if (!existsSync(source)) throw new Error(`Missing private deployment config: ${source}`);
  const credentials = join(secretsDir, "cloudflare.env");
  if (existsSync(credentials)) process.loadEnvFile(credentials);
  const text = readFileSync(source, "utf8").replace(/^\s*\/\/.*$/gmu, "");
  const config = JSON.parse(text) as Record<string, unknown> & { main?: string; d1_databases?: { migrations_dir?: string }[] };
  delete config.$schema;
  config.main = join(root, config.main ?? "src/index.ts");
  for (const database of config.d1_databases ?? []) database.migrations_dir = join(root, database.migrations_dir ?? "migrations");
  const directory = mkdtempSync(join(tmpdir(), "career-mcp-deploy-"));
  chmodSync(directory, 0o700);
  const path = join(directory, "wrangler.json");
  writeFileSync(path, JSON.stringify(config), { mode: 0o600 });
  // Wrangler binds auth profiles to the config's directory; a temporary config
  // needs the profile named explicitly. CI authenticates with an API token instead.
  const profileFile = join(secretsDir, "wrangler-profile");
  const profile = existsSync(profileFile) ? readFileSync(profileFile, "utf8").trim() : "";
  const args = ["--config", path, ...(profile && !process.env.CLOUDFLARE_API_TOKEN ? ["--profile", profile] : [])];
  return { path, args, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let config: ReturnType<typeof remoteConfig> | undefined;
  try {
    config = remoteConfig();
    const result = spawnSync(process.execPath, [wrangler, ...process.argv.slice(2), ...config.args], {
      cwd: root, stdio: "inherit", env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    });
    process.exitCode = result.status ?? 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    config?.cleanup();
  }
}

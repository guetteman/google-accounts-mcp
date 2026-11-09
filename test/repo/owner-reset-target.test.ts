import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

// `pnpm owner:reset` must change exactly the database it shows, however wrangler would otherwise
// pick one: by environment variables, .env files, a configuration edited while it waits, a
// database_name that collides with the binding, or a local preview ID. Each test keeps two local
// databases and checks that only the one shown changes.
const TIMEOUT = 180_000;
const SCRIPT = fileURLToPath(new URL("../../scripts/owner-reset.ts", import.meta.url));
const WRANGLER = fileURLToPath(new URL("../../node_modules/.bin/wrangler", import.meta.url));
const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));
const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const BASE_ENV = { ...process.env, WRANGLER_SEND_METRICS: "false", CLOUDFLARE_ENV: undefined };

let dir = "";
const persistTo = () => join(dir, "state");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "owner-reset-target-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeConfig(file: string, config: Record<string, unknown>): string {
  const path = join(dir, file);
  writeFileSync(
    path,
    JSON.stringify({ name: "reset-target", compatibility_date: "2026-10-20", ...config }),
  );
  return path;
}

const db = (id: string, extra: Record<string, unknown> = {}) => ({
  binding: "DB",
  database_id: id,
  migrations_dir: MIGRATIONS,
  ...extra,
});

function wrangler(config: string, ...args: string[]): string {
  const result = spawnSync(
    WRANGLER,
    [...args, "--local", "--persist-to", persistTo(), "--config", config],
    { encoding: "utf8", cwd: dir, env: BASE_ENV },
  );
  if (result.status !== 0) throw new Error(`${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

/** A local database keyed by `id`, holding an owner pinned at `generation`. */
function seed(id: string, generation: number) {
  const config = writeConfig(`seed-${id}.json`, { d1_databases: [db(id)] });
  wrangler(config, "d1", "migrations", "apply", "DB");
  wrangler(
    config,
    "d1",
    "execute",
    "DB",
    "--json",
    "--command",
    `UPDATE owner SET state = 'pinned', generation = ${generation}, email = 'owner-${generation}@example.com', google_sub = 's' WHERE id = 1`,
  );
}

function generationOf(id: string): number {
  const config = writeConfig(`read-${id}.json`, { d1_databases: [db(id)] });
  const out = JSON.parse(
    wrangler(config, "d1", "execute", "DB", "--json", "--command", "SELECT generation FROM owner"),
  ) as Array<{ results: Array<{ generation: number }> }>;
  return out[0]?.results[0]?.generation ?? Number.NaN;
}

function reset(args: string[], env: Record<string, string | undefined> = {}) {
  return spawnSync(process.execPath, [SCRIPT, "--local", "--persist-to", persistTo(), ...args], {
    encoding: "utf8",
    cwd: dir,
    env: { ...BASE_ENV, ...env },
  });
}

const twoEnvironments = () =>
  writeConfig("wrangler.jsonc", {
    d1_databases: [db(A)],
    env: { staging: { d1_databases: [db(B)] } },
  });

describe("pnpm owner:reset changes only the database it shows", () => {
  it(
    "follows CLOUDFLARE_ENV from a .env file and shows that environment",
    () => {
      seed(A, 1);
      seed(B, 5);
      const config = twoEnvironments();
      writeFileSync(join(dir, ".env"), "CLOUDFLARE_ENV=staging\n");

      const run = reset(["--config", config, "--yes"]);

      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout).toContain("Environment: staging");
      expect(run.stdout).toContain(B);
      expect(generationOf(B)).toBe(6);
      expect(generationOf(A)).toBe(1);
    },
    TIMEOUT,
  );

  it(
    'selects the top level with --env "" even when CLOUDFLARE_ENV names another environment',
    () => {
      seed(A, 1);
      seed(B, 5);
      const config = twoEnvironments();

      const run = reset(["--config", config, "--env", "", "--yes"], { CLOUDFLARE_ENV: "staging" });

      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout).toContain("Environment: top level");
      expect(run.stdout).toContain(A);
      expect(generationOf(A)).toBe(2);
      expect(generationOf(B)).toBe(5);
    },
    TIMEOUT,
  );

  it(
    "keeps the database it showed when the configuration changes while it waits for confirmation",
    async () => {
      seed(A, 7);
      seed(B, 7);
      const config = writeConfig("wrangler.jsonc", { d1_databases: [db(A)] });

      const child = spawn(
        process.execPath,
        [SCRIPT, "--local", "--persist-to", persistTo(), "--config", config],
        { cwd: dir, env: BASE_ENV },
      );
      let stdout = "";
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      const exited = new Promise<number | null>((resolve) => child.on("close", resolve));
      await new Promise<void>((resolve, reject) => {
        child.stdout.on("data", (chunk: Buffer) => {
          stdout += chunk.toString();
          if (stdout.includes('Type "reset"')) resolve();
        });
        child.on("close", () => reject(new Error(`exited before the prompt: ${stdout}${stderr}`)));
      });
      expect(stdout).toContain(A);
      writeConfig("wrangler.jsonc", { d1_databases: [db(B)] });
      child.stdin.end("reset\n");

      expect(await exited, stderr).toBe(0);
      expect(generationOf(A)).toBe(8);
      expect(generationOf(B)).toBe(7);
    },
    TIMEOUT,
  );

  it(
    "refuses a configuration where another database is also named DB, and changes nothing",
    () => {
      seed(A, 1);
      seed(B, 5);
      const config = writeConfig("wrangler.jsonc", {
        d1_databases: [db(A, { binding: "OTHER", database_name: "DB" }), db(B)],
      });

      const run = reset(["--config", config, "--yes"]);

      expect(run.status).not.toBe(0);
      expect(run.stderr).toMatch(/more than one D1 database DB/);
      expect(generationOf(A)).toBe(1);
      expect(generationOf(B)).toBe(5);
    },
    TIMEOUT,
  );

  it(
    "uses and shows the preview database locally when the configuration has one",
    () => {
      seed(A, 1);
      seed(B, 5);
      const config = writeConfig("wrangler.jsonc", {
        d1_databases: [db(A, { preview_database_id: B })],
      });

      const run = reset(["--config", config, "--yes"]);

      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout).toContain(`id ${B} (local)`);
      expect(run.stdout).not.toContain(A);
      expect(generationOf(B)).toBe(6);
      expect(generationOf(A)).toBe(1);
    },
    TIMEOUT,
  );

  it(
    "leaves no frozen configuration behind",
    () => {
      seed(A, 1);
      const config = writeConfig("wrangler.jsonc", { d1_databases: [db(A)] });
      reset(["--config", config, "--yes"]);
      reset(["--config", config], {});
      expect(readdirSync(dir).filter((name) => name.startsWith(".owner-reset-"))).toEqual([]);
    },
    TIMEOUT,
  );
});

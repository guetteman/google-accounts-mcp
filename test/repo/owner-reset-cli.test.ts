import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

// The deployer's command against a local D1, through the same `wrangler d1 execute` it uses
// remotely. Each wrangler call takes about a second.
const TIMEOUT = 120_000;
const OWNER = "alex.personal@example.com";

let persistTo = "";

function wrangler(...args: string[]) {
  const result = spawnSync(
    "pnpm",
    ["exec", "wrangler", ...args, "--local", "--persist-to", persistTo],
    {
      encoding: "utf8",
      env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" },
    },
  );
  if (result.status !== 0)
    throw new Error(`wrangler ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

function sql(command: string): Array<Record<string, unknown>> {
  const out = JSON.parse(wrangler("d1", "execute", "DB", "--json", "--command", command)) as Array<{
    results: Array<Record<string, unknown>>;
  }>;
  return out.flatMap((statement) => statement.results);
}

function ownerReset(args: string[], input?: string, extraEnv: Record<string, string> = {}) {
  return spawnSync(
    "pnpm",
    ["--silent", "owner:reset", "--local", "--persist-to", persistTo, ...args],
    {
      encoding: "utf8",
      input: input ?? "",
      env: { ...process.env, WRANGLER_SEND_METRICS: "false", ...extraEnv },
    },
  );
}

const owner = () => sql("SELECT state, generation, email FROM owner WHERE id = 1")[0];

beforeEach(() => {
  persistTo = mkdtempSync(join(tmpdir(), "owner-reset-"));
  wrangler("d1", "migrations", "apply", "DB");
});

afterEach(() => {
  rmSync(persistTo, { recursive: true, force: true });
});

describe("pnpm owner:reset", () => {
  it(
    "shows which deploy and owner it will change, and changes nothing until the deployer types reset",
    () => {
      sql(`UPDATE owner SET state = 'pinned', generation = 3, email = '${OWNER}' WHERE id = 1; `);

      const declined = ownerReset([], "no\n");
      const shown = declined.stdout;
      expect(shown).toContain("google-accounts-mcp-db");
      expect(shown).toContain("wrangler.jsonc");
      expect(shown).toContain(OWNER);
      expect(shown).toMatch(/pinned/i);
      expect(shown).toMatch(/generation\D*3\b/i);
      expect(owner()).toEqual({
        state: "pinned",
        generation: 3,
        email: OWNER,
      });

      const confirmed = ownerReset([], "reset\n");
      expect(confirmed.status, confirmed.stderr).toBe(0);
      expect(confirmed.stdout).toMatch(/next owner request for OWNER_EMAIL becomes the owner/i);
      expect(owner()).toEqual({ state: "unpinned", generation: 4, email: null });
    },
    TIMEOUT,
  );

  it(
    "says there is no owner on a freshly migrated deploy, and still resets with --yes",
    () => {
      const run = ownerReset(["--yes"]);
      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout).toMatch(/no owner/i);
      expect(run.stdout).toMatch(/next owner request for OWNER_EMAIL becomes the owner/i);
      expect(owner()).toEqual({ state: "unpinned", generation: 2, email: null });
    },
    TIMEOUT,
  );

  it(
    "continues a reset that stopped halfway",
    () => {
      sql(
        `UPDATE owner SET state = 'resetting', generation = 5, email = '${OWNER}' WHERE id = 1; `,
      );

      const run = ownerReset(["--yes"]);

      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout).toMatch(/reset is in progress/i);
      expect(owner()).toEqual({ state: "unpinned", generation: 5, email: null });
    },
    TIMEOUT,
  );

  it(
    "names the database by its ID when the configuration has one, as wrangler finds it",
    () => {
      const configPath = join(persistTo, "wrangler.jsonc");
      writeFileSync(
        configPath,
        JSON.stringify({
          name: "review-stage",
          main: "src/index.ts",
          compatibility_date: "2026-10-20",
          d1_databases: [{ binding: "DB", database_id: "00000000-0000-4000-8000-000000000000" }],
        }),
      );

      const run = ownerReset(["--config", configPath]);

      expect(run.stdout).toContain("Database: id 00000000-0000-4000-8000-000000000000");
      expect(run.stdout).not.toContain("review-stage-db");
      expect(run.stdout).toContain(configPath);
    },
    TIMEOUT,
  );
});

it.each([
  ["--env", ["--env", "staging"], {}],
  ["CLOUDFLARE_ENV", [], { CLOUDFLARE_ENV: "staging" }],
  ["--env over CLOUDFLARE_ENV", ["--env", "staging"], { CLOUDFLARE_ENV: "production" }],
] as const)(
  "resets only the environment chosen with %s in the chosen configuration and shows its database and owner",
  (_label, selector, selectorEnv) => {
    const configPath = join(persistTo, "wrangler.jsonc");
    const topId = "00000000-0000-4000-8000-000000000001";
    const stagingId = "00000000-0000-4000-8000-000000000002";
    const stagingEmail = "alex.staging@example.com";
    const topEmail = "alex.top@example.com";
    const binding = (databaseId: string) => [
      {
        binding: "DB",
        database_id: databaseId,
        migrations_dir: fileURLToPath(new URL("../../migrations", import.meta.url)),
      },
    ];
    writeFileSync(
      configPath,
      JSON.stringify({
        name: "owner-reset-environments",
        main: fileURLToPath(new URL("../../src/index.ts", import.meta.url)),
        compatibility_date: "2026-10-20",
        d1_databases: binding(topId),
        env: { staging: { d1_databases: binding(stagingId) } },
      }),
    );
    const selectedSql = (command: string, environment?: string) => {
      const output = wrangler(
        "d1",
        "execute",
        "DB",
        "--json",
        "--command",
        command,
        "--config",
        configPath,
        ...(environment ? ["--env", environment] : []),
      );
      return (JSON.parse(output) as Array<{ results: Array<Record<string, unknown>> }>).flatMap(
        (entry) => entry.results,
      );
    };
    for (const environment of [undefined, "staging"]) {
      wrangler(
        "d1",
        "migrations",
        "apply",
        "DB",
        "--config",
        configPath,
        ...(environment ? ["--env", environment] : []),
      );
      const email = environment ? stagingEmail : topEmail;
      const generation = environment ? 3 : 7;
      selectedSql(
        `UPDATE owner SET state = 'pinned', generation = ${generation}, email = '${email}' WHERE id = 1`,
        environment,
      );
    }

    const run = ownerReset(["--config", configPath, ...selector, "--yes"], undefined, selectorEnv);

    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain("Environment: staging");
    expect(run.stdout).toContain(`Configuration: ${configPath}`);
    expect(run.stdout).toContain(stagingId);
    expect(run.stdout).toContain(stagingEmail);
    const read = "SELECT state, generation, email FROM owner WHERE id = 1";
    expect(selectedSql(read, "staging")).toEqual([
      {
        state: "unpinned",
        generation: 4,
        email: null,
      },
    ]);
    expect(selectedSql(read)).toEqual([
      {
        state: "pinned",
        generation: 7,
        email: topEmail,
      },
    ]);
  },
  TIMEOUT,
);

it.fails(
  "deletes active and revoked connections only after a local reset is confirmed",
  () => {
    sql(`UPDATE owner SET state = 'pinned', generation = 3, email = '${OWNER}' WHERE id = 1;
      INSERT INTO connections (id, generation, grant_id, app, name, state, created_at, expires_at, revoked_at) VALUES
      ('00000000-0000-4000-8000-000000000001', 3, 'test-grant-one', 'claude-code', 'Work laptop', 'active', 1, 9999999999999, NULL),
      ('00000000-0000-4000-8000-000000000002', 2, 'test-grant-two', 'chatgpt', 'Ended connection', 'revoked', 1, 2, 2)`);
    const before = sql("SELECT * FROM connections ORDER BY id");
    expect(before).toHaveLength(2);
    expect(ownerReset([], "no\n").status).toBe(0);
    expect(sql("SELECT * FROM connections ORDER BY id")).toEqual(before);
    const confirmed = ownerReset([], "reset\n");
    expect(confirmed.status, confirmed.stderr).toBe(0);
    expect(owner()).toEqual({ state: "unpinned", generation: 4, email: null });
    expect(sql("SELECT * FROM connections")).toEqual([]);
  },
  TIMEOUT,
);

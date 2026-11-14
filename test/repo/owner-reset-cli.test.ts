import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vite-plus/test";

// The deployer's command against a local D1, through the same `wrangler d1 execute` it uses
// remotely. Each wrangler call takes seconds, so the tests make as few as they can.
const TIMEOUT = 120_000;
const OWNER = "alex.personal@example.com";
const OWNER_TABLES = [
  "connections",
  "accounts",
  "permissions",
  "calls",
  "call_accounts",
  "approvals",
  "once",
  "uploads",
];

let persistTo = "";

function wrangler(...args: string[]) {
  const result = spawnSync(
    "pnpm",
    ["exec", "wrangler", ...args, "--local", "--persist-to", persistTo],
    { encoding: "utf8", env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" } },
  );
  if (result.status !== 0)
    throw new Error(`wrangler ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

const sql = (command: string) =>
  (
    JSON.parse(wrangler("d1", "execute", "DB", "--json", "--command", command)) as Array<{
      results: Array<Record<string, unknown>>;
    }>
  ).map((statement) => statement.results);

const ownerReset = (args: string[], input = "") =>
  spawnSync("pnpm", ["--silent", "owner:reset", ...args], {
    encoding: "utf8",
    input,
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  });

beforeAll(() => {
  persistTo = mkdtempSync(join(tmpdir(), "owner-reset-"));
  wrangler("d1", "migrations", "apply", "DB");
}, TIMEOUT);

afterAll(() => {
  rmSync(persistTo, { recursive: true, force: true });
});

it("refuses an unknown argument before it reads any database", () => {
  const run = ownerReset(["--local", "--persist-to", persistTo, "--bogus"], "reset\n");
  expect(run.status).toBe(1);
  expect(run.stderr).toContain("Unknown argument: --bogus");
  expect(run.stdout).not.toContain("Database:");
});

it(
  "shows the database and its owner, changes nothing unless the deployer types reset, and then resets",
  () => {
    sql(`UPDATE owner SET state = 'pinned', generation = 3, email = '${OWNER}' WHERE id = 1;
      INSERT INTO connections (id, generation, grant_id, app, name, state, created_at, expires_at, revoked_at) VALUES
      ('00000000-0000-4000-8000-000000000001', 3, 'test-grant-one', 'claude-code', 'Work laptop', 'active', 1, 9999999999999, NULL);
      INSERT INTO accounts (id,generation,sub,email,name,state,created_at,version,scopes,health,refresh_token,access_token,access_expires_at)
      VALUES ('00000000-0000-4000-8000-000000000003',3,'personal','${OWNER}','Personal','live',1,1,'[]','ready','sealed-refresh','sealed-access',9999999999999)`);
    const local = ["--local", "--persist-to", persistTo];

    const declined = ownerReset(local, "no\n");
    expect(declined.status, declined.stderr).toBe(0);
    const prompt = declined.stdout.indexOf('Type "reset"');
    expect(prompt).toBeGreaterThan(0);
    const shown = declined.stdout.slice(0, prompt);
    expect(shown).toContain("Database: binding DB (local)");
    expect(shown).toContain("Configuration: wrangler.jsonc");
    expect(shown).toContain("Environment: top level");
    expect(shown).toContain(`Stored owner: ${OWNER}`);
    expect(shown).toContain("State: pinned, generation 3");
    expect(declined.stdout).toContain("Nothing changed.");

    // Every reset run raises the generation, so generation 4 at the end also proves the declined
    // run ran none of the reset.
    const confirmed = ownerReset(local, "reset\n");
    expect(confirmed.status, confirmed.stderr).toBe(0);
    expect(confirmed.stdout).toMatch(/next owner request for OWNER_EMAIL becomes the owner/i);
    const [owner, ...tables] = sql(
      [
        "SELECT state, generation, email FROM owner WHERE id = 1",
        ...OWNER_TABLES.map((table) => `SELECT '${table}' AS name, count(*) AS rows FROM ${table}`),
      ].join("; "),
    );
    expect(owner).toEqual([{ state: "unpinned", generation: 4, email: null }]);
    expect(tables.flat()).toEqual(OWNER_TABLES.map((name) => ({ name, rows: 0 })));
  },
  TIMEOUT,
);

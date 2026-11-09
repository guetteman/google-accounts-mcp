import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

function ownerReset(args: string[], input?: string) {
  return spawnSync(
    "pnpm",
    ["--silent", "owner:reset", "--local", "--persist-to", persistTo, ...args],
    {
      encoding: "utf8",
      input: input ?? "",
      env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    },
  );
}

const owner = () => sql("SELECT state, generation, email, google_sub FROM owner WHERE id = 1")[0];
const sessionCount = () => sql("SELECT COUNT(*) AS n FROM owner_sessions")[0]?.n;

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
      sql(
        `UPDATE owner SET state = 'pinned', generation = 3, email = '${OWNER}', google_sub = 'sub-a' WHERE id = 1; ` +
          "INSERT INTO owner_sessions (token_hash, generation, created_at, last_used_at) VALUES ('h1', 3, 1, 1), ('h2', 3, 1, 1)",
      );

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
        google_sub: "sub-a",
      });
      expect(sessionCount()).toBe(2);

      const confirmed = ownerReset([], "reset\n");
      expect(confirmed.status, confirmed.stderr).toBe(0);
      expect(confirmed.stdout).toMatch(/next sign-in as OWNER_EMAIL becomes the owner/i);
      expect(owner()).toEqual({ state: "unpinned", generation: 4, email: null, google_sub: null });
      expect(sessionCount()).toBe(0);
    },
    TIMEOUT,
  );

  it(
    "says there is no owner on a freshly migrated deploy, and still resets with --yes",
    () => {
      const run = ownerReset(["--yes"]);
      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout).toMatch(/no owner/i);
      expect(run.stdout).toMatch(/next sign-in as OWNER_EMAIL becomes the owner/i);
      expect(owner()).toEqual({ state: "unpinned", generation: 2, email: null, google_sub: null });
    },
    TIMEOUT,
  );

  it(
    "continues a reset that stopped halfway",
    () => {
      sql(
        `UPDATE owner SET state = 'resetting', generation = 5, email = '${OWNER}', google_sub = 'sub-a' WHERE id = 1; ` +
          "INSERT INTO owner_sessions (token_hash, generation, created_at, last_used_at) VALUES ('h1', 4, 1, 1)",
      );

      const run = ownerReset(["--yes"]);

      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout).toMatch(/reset is in progress/i);
      expect(owner()).toEqual({ state: "unpinned", generation: 5, email: null, google_sub: null });
      expect(sessionCount()).toBe(0);
    },
    TIMEOUT,
  );
});

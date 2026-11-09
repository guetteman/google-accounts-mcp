import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { unstable_readConfig } from "wrangler";
import { resetOutcome, resetPlan, type OwnerState } from "../src/owner/reset.ts";
import { databaseLabel, ownerDatabase, type D1BindingConfig } from "./d1-target.ts";

interface StatementResult {
  readonly results: unknown[];
}
interface StoredOwner {
  readonly state: OwnerState;
  readonly generation: number;
  readonly email: string | null;
}

async function main() {
  const args = process.argv.slice(2);
  let configPath = "wrangler.jsonc";
  let environmentArg: string | undefined;
  let persistTo: string | undefined;
  let local = false;
  let yes = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--yes") yes = true;
    else if (arg === "--local") local = true;
    else if (arg === "--persist-to" || arg === "--config" || arg === "--env") {
      const value = args[++i];
      // `--env ""` selects the top level, as in wrangler.
      if (value === undefined || value.startsWith("--") || (value === "" && arg !== "--env"))
        throw new Error(`Missing value for ${arg}`);
      if (arg === "--config") configPath = value;
      else if (arg === "--env") environmentArg = value;
      else persistTo = value;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (persistTo !== undefined && !local) throw new Error("--persist-to needs --local.");

  const environment = environmentArg ?? cloudflareEnv();
  const config: { name?: string; account_id?: string; d1_databases: D1BindingConfig[] } =
    unstable_readConfig({ config: configPath, env: environment }, { hideWarnings: true });
  const database = ownerDatabase(config.d1_databases);
  console.log(`Database: ${databaseLabel(config.name, database, local ? "local" : "remote")}`);
  console.log(`Configuration: ${configPath}`);
  console.log(environment ? `Environment: ${environment}` : "Environment: top level");

  // Wrangler reads its configuration and environment again on every call. To change only the
  // database shown above, every call gets this one resolved database, frozen in a file next to
  // the configuration (so local state, .env files, and profiles resolve as before), and
  // `--env ""`, which stops CLOUDFLARE_ENV from choosing another environment.
  const frozenPath = join(dirname(resolve(configPath)), `.owner-reset-${process.pid}.json`);
  writeFileSync(
    frozenPath,
    JSON.stringify({
      name: config.name,
      ...(config.account_id ? { account_id: config.account_id } : {}),
      compatibility_date: "2026-10-20",
      d1_databases: [database],
    }),
    { flag: "wx" },
  );
  try {
    await run({ frozenPath, local, persistTo, yes });
  } finally {
    rmSync(frozenPath, { force: true });
  }
}

/** CLOUDFLARE_ENV as wrangler reads it: the process environment, then .env.local, then .env. */
function cloudflareEnv(): string | undefined {
  if (process.env.CLOUDFLARE_ENV !== undefined) return process.env.CLOUDFLARE_ENV;
  let value: string | undefined;
  for (const file of [".env", ".env.local"]) {
    if (!existsSync(file)) continue;
    const parsed = parseEnv(readFileSync(file, "utf8"));
    if (parsed.CLOUDFLARE_ENV !== undefined) value = parsed.CLOUDFLARE_ENV;
  }
  return value;
}

async function run(options: {
  readonly frozenPath: string;
  readonly local: boolean;
  readonly persistTo: string | undefined;
  readonly yes: boolean;
}) {
  const { frozenPath, local, persistTo, yes } = options;
  function execute(command: string): StatementResult[] {
    const result = spawnSync(
      fileURLToPath(new URL("../node_modules/.bin/wrangler", import.meta.url)),
      [
        "d1",
        "execute",
        "DB",
        "--json",
        "--command",
        command,
        local ? "--local" : "--remote",
        ...(persistTo === undefined ? [] : ["--persist-to", persistTo]),
        "--config",
        frozenPath,
        "--env",
        "",
      ],
      { encoding: "utf8", env: { ...process.env, WRANGLER_SEND_METRICS: "false" } },
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      throw new Error(result.error?.message || result.stderr || "Wrangler did not return JSON.");
    }
    if (parsed && typeof parsed === "object" && "error" in parsed)
      throw new Error(JSON.stringify(parsed.error));
    if (result.status !== 0)
      throw new Error(result.stderr || `Wrangler exited with status ${result.status}`);
    if (
      !Array.isArray(parsed) ||
      !parsed.every(
        (entry: unknown) =>
          entry && typeof entry === "object" && "results" in entry && Array.isArray(entry.results),
      )
    ) {
      throw new Error("Wrangler returned an unexpected result.");
    }
    return parsed as StatementResult[];
  }

  function readOwner(): StoredOwner {
    const row = execute("SELECT state, generation, email FROM owner WHERE id = 1")[0]?.results[0];
    if (
      !row ||
      typeof row !== "object" ||
      !("state" in row) ||
      !("generation" in row) ||
      !("email" in row) ||
      !["pinned", "unpinned", "resetting"].includes(String(row.state)) ||
      typeof row.generation !== "number" ||
      !Number.isSafeInteger(row.generation) ||
      row.generation < 1 ||
      (row.email !== null && typeof row.email !== "string")
    )
      throw new Error("The stored owner row is missing or invalid.");
    return row as StoredOwner;
  }

  function describe(row: StoredOwner) {
    console.log(`Stored owner: ${row.email ?? "no owner"}`);
    const state =
      row.state === "resetting"
        ? "a reset is in progress"
        : row.state === "unpinned"
          ? "unpinned (no owner)"
          : "pinned";
    console.log(`State: ${state}, generation ${row.generation}`);
  }

  const row = readOwner();
  describe(row);
  console.log("Reset ends every session and removes all data from the previous owner.");
  if (!yes) {
    const readline = createInterface({ input: process.stdin, output: process.stdout });
    let answer: string;
    try {
      answer = await Promise.race([
        readline.question('Type "reset" to continue: '),
        new Promise<string>((resolve) => readline.once("close", () => resolve(""))),
      ]);
    } finally {
      readline.close();
    }
    if (answer !== "reset") {
      console.log("Nothing changed.");
      return;
    }
  }
  const plan = resetPlan(row, Date.now());
  const results = execute(plan.statements.join("; "));
  switch (resetOutcome(plan, results)) {
    case "overtaken":
      console.log(
        "Another reset changed the database first; nothing done. Run again to see the current state.",
      );
      break;
    case "done":
      console.log("Done. The next sign-in as OWNER_EMAIL becomes the owner.");
      break;
    case "unknown":
      console.log("The reset did not finish here. Current database state:");
      describe(readOwner());
      break;
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

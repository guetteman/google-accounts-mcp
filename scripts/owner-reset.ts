import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { unstable_readConfig } from "wrangler";
import { resetOutcome, resetPlan, type OwnerState } from "../src/owner/reset.ts";
import {
  databaseLabel,
  describeTarget,
  ownerDatabase,
  sameTarget,
  targetMatches,
  wranglerTarget,
  type D1BindingConfig,
  type WranglerTarget,
} from "./d1-target.ts";

interface StatementResult {
  readonly results: unknown[];
}
interface StoredOwner {
  readonly state: OwnerState;
  readonly generation: number;
  readonly email: string | null;
  readonly instance: number;
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
  const mode = local ? "local" : "remote";

  // The environment is decided here and passed to every wrangler call, so wrangler cannot pick
  // another one from a .env file.
  const environment = environmentArg ?? process.env.CLOUDFLARE_ENV ?? "";
  const config: { name?: string; d1_databases: D1BindingConfig[] } = unstable_readConfig(
    { config: configPath, env: environment },
    { hideWarnings: true },
  );
  const database = ownerDatabase(config.d1_databases);
  const wranglerArgs = [
    local ? "--local" : "--remote",
    ...(persistTo === undefined ? [] : ["--persist-to", persistTo]),
    "--config",
    configPath,
    "--env",
    environment,
  ];

  function wrangler(extra: string[]) {
    return spawnSync(
      fileURLToPath(new URL("../node_modules/.bin/wrangler", import.meta.url)),
      ["d1", "execute", "DB", ...extra, ...wranglerArgs],
      { encoding: "utf8", env: { ...process.env, WRANGLER_SEND_METRICS: "false" } },
    );
  }

  function statementResults(parsed: unknown): StatementResult[] {
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

  /** Reads the owner row and the database wrangler says it read it from. */
  function readOwner(): { row: StoredOwner; target: WranglerTarget } {
    const result = wrangler([
      "--command",
      "SELECT state, generation, email, instance FROM owner WHERE id = 1",
    ]);
    if (result.status !== 0)
      throw new Error(result.stderr || result.error?.message || "Wrangler failed.");
    const target = wranglerTarget(result.stdout);
    const json = result.stdout.indexOf("\n[");
    if (!target || json < 0) throw new Error("Could not read which database wrangler used.");
    if (!targetMatches(target, database, mode)) {
      throw new Error(
        `Wrangler used the ${target.mode} database ${target.id}, not the configured one; nothing changed.`,
      );
    }
    const row = statementResults(JSON.parse(result.stdout.slice(json + 1)))[0]?.results[0];
    if (
      !row ||
      typeof row !== "object" ||
      !("state" in row) ||
      !("generation" in row) ||
      !("email" in row) ||
      !("instance" in row) ||
      !["pinned", "unpinned", "resetting"].includes(String(row.state)) ||
      typeof row.generation !== "number" ||
      !Number.isSafeInteger(row.generation) ||
      row.generation < 1 ||
      typeof row.instance !== "number" ||
      !Number.isSafeInteger(row.instance) ||
      row.instance < 1 ||
      (row.email !== null && typeof row.email !== "string")
    )
      throw new Error("The stored owner row is missing or invalid.");
    return { row: row as StoredOwner, target };
  }

  /** Runs statements as one call; reports wrangler's JSON error without changing anything more. */
  function execute(command: string): StatementResult[] {
    const result = wrangler(["--json", "--command", command]);
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
    return statementResults(parsed);
  }

  function describe({ row, target }: { row: StoredOwner; target: WranglerTarget }) {
    console.log(`Wrangler used: ${describeTarget(target, mode)}, instance ${row.instance}`);
    console.log(`Stored owner: ${row.email ?? "no owner"}`);
    const state =
      row.state === "resetting"
        ? "a reset is in progress"
        : row.state === "unpinned"
          ? "unpinned (no owner)"
          : "pinned";
    console.log(`State: ${state}, generation ${row.generation}`);
  }

  console.log(`Database: ${databaseLabel(config.name, database, mode)}`);
  console.log(`Configuration: ${configPath}`);
  console.log(environment ? `Environment: ${environment}` : "Environment: top level");
  const read = readOwner();
  describe(read);
  console.log("Reset removes all data from the previous owner.");
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
  // Wrangler reads its configuration again on every call. Read once more right before writing and
  // stop if anything differs from what was shown. Beyond that, every statement is guarded on the
  // instance read above, so a write that still reaches another database changes nothing there.
  const again = readOwner();
  if (
    !sameTarget(read.target, again.target) ||
    JSON.stringify(read.row) !== JSON.stringify(again.row)
  ) {
    console.log("The database or its owner changed while waiting; nothing changed. Run again.");
    process.exitCode = 1;
    return;
  }
  const plan = resetPlan(read.row);
  const results = execute(plan.statements.join("; "));
  switch (resetOutcome(plan, results)) {
    case "overtaken":
      console.log(
        "The database changed before the reset ran (another reset, or wrangler reached a different database); nothing done. Run again to see the current state.",
      );
      break;
    case "done":
      console.log("Done. The next owner request for OWNER_EMAIL becomes the owner.");
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

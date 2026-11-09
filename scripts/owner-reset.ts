import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { unstable_readConfig } from "wrangler";
import { resetOutcome, resetPlan, type OwnerState } from "../src/owner/reset.ts";

interface StatementResult {
  readonly results: unknown[];
}
interface StoredOwner {
  readonly state: OwnerState;
  readonly generation: number;
  readonly email: string | null;
}

/**
 * The database wrangler will change, named the way wrangler finds it: by `database_id` when the
 * configuration has one, otherwise by `database_name`, otherwise by the name it gives a database
 * it provisioned, `<worker name>-<binding>`.
 */
function databaseLabel(
  worker: string | undefined,
  db: { binding: string; database_name?: string; database_id?: string },
): string {
  if (db.database_id)
    return db.database_name ? `${db.database_name}, id ${db.database_id}` : `id ${db.database_id}`;
  if (db.database_name) return db.database_name;
  if (!worker) throw new Error("The configuration names no D1 database for DB and no Worker name.");
  return `${worker}-${db.binding.toLowerCase().replaceAll("_", "-")}`;
}

async function main() {
  const args = process.argv.slice(2);
  const passThrough: string[] = [];
  let configPath = "wrangler.jsonc";
  let environment: string | undefined;
  let local = false;
  let yes = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--yes") yes = true;
    else if (arg === "--local") local = true;
    else if (arg === "--persist-to" || arg === "--config" || arg === "--env") {
      const value = args[++i];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
      if (arg === "--config") configPath = value;
      else {
        passThrough.push(arg, value);
        if (arg === "--env") environment = value;
      }
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  const config: {
    name?: string;
    d1_databases: { binding: string; database_name?: string; database_id?: string }[];
  } = unstable_readConfig({ config: configPath, env: environment }, { hideWarnings: true });
  const binding = config.d1_databases.find((db) => db.binding === "DB");
  if (!binding) throw new Error("The configuration has no D1 binding named DB.");
  console.log(`Database: ${databaseLabel(config.name, binding)} (${local ? "local" : "remote"})`);
  console.log(`Configuration: ${configPath}`);
  console.log(environment ? `Environment: ${environment}` : "Environment: top level");

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
        "--config",
        configPath,
        ...passThrough,
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

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
interface D1BindingConfig {
  readonly binding: string;
  readonly database_name?: string;
  readonly database_id?: string;
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

  // The environment is decided here and passed to every wrangler call, so wrangler cannot pick
  // another one from a .env file.
  const environment = environmentArg ?? process.env.CLOUDFLARE_ENV ?? "";
  const config: { d1_databases: D1BindingConfig[] } = unstable_readConfig(
    { config: configPath, env: environment },
    { hideWarnings: true },
  );
  const database = config.d1_databases.find((db) => db.binding === "DB");
  if (!database) throw new Error("The configuration has no D1 binding named DB.");
  const wranglerArgs = [
    local ? "--local" : "--remote",
    ...(persistTo === undefined ? [] : ["--persist-to", persistTo]),
    "--config",
    configPath,
    "--env",
    environment,
  ];

  /** Runs statements as one call; reports wrangler's JSON error without changing anything more. */
  function execute(command: string): StatementResult[] {
    const result = spawnSync(
      fileURLToPath(new URL("../node_modules/.bin/wrangler", import.meta.url)),
      ["d1", "execute", "DB", "--json", "--command", command, ...wranglerArgs],
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
    )
      throw new Error("Wrangler returned an unexpected result.");
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

  const label = ["binding DB"];
  if (database.database_name) label.push(database.database_name);
  if (database.database_id) label.push(`id ${database.database_id}`);
  console.log(`Database: ${label.join(", ")} (${local ? "local" : "remote"})`);
  console.log(`Configuration: ${configPath}`);
  console.log(environment ? `Environment: ${environment}` : "Environment: top level");
  const row = readOwner();
  describe(row);
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
  // Every statement is guarded on the generation read above, so a reset that another one
  // overtook while this one waited changes nothing.
  const plan = resetPlan(row);
  switch (resetOutcome(plan, execute(plan.statements.join("; ")))) {
    case "overtaken":
      console.log(
        "The owner changed before the reset ran (another reset began); nothing done. Run again to see the current state.",
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

import { readFile } from "node:fs/promises";
import { expect, it } from "vite-plus/test";

it("schedules approval cleanup every ten minutes", async () => {
  const config = await readFile("wrangler.jsonc", "utf8");
  expect(config).toMatch(/"crons":\s*\["\*\/10 \* \* \* \*"\]/);
});
it("documents migration order, browser control risk and every approval preview", async () => {
  const readme = await readFile("README.md", "utf8");
  expect(readme).toContain("migrations/0005_approvals.sql");
  expect(readme).toContain("Deploy the code only after the migrations succeed");
  expect(readme).toContain(
    "An agent that controls a browser where the owner is signed in can approve its own call or change its own settings",
  );
  expect(readme).toContain(
    "revoking a connection, removing an account, and setting a tool to deny return HTTP 503 and change nothing",
  );
  expect(readme).toContain("Account tool calls fail without an audit record");
  expect(readme).toContain("cron trigger (`*/10 * * * *`)");
  const agents = await readFile("AGENTS.md", "utf8");
  expect(agents).toContain("the approval page, and the permission control");
  for (const name of [
    "waiting",
    "waiting-long-names",
    "cannot-show",
    "changed",
    "running",
    "succeeded",
    "failed",
    "unknown",
    "rejected",
    "expired",
    "ended-tool",
    "ended-connection",
    "ended-account",
    "unconfirmed",
  ])
    expect(agents).toContain(`\`approval-${name}\``);
});

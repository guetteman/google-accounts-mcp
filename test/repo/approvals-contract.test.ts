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
  const agents = await readFile("AGENTS.md", "utf8");
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

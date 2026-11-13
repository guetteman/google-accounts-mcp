import { env } from "cloudflare:workers";
import { expect, it } from "vite-plus/test";
import type { TestEnv } from "./env";
import { activityFixture, approval, record } from "./support/activity";
import { seedAccount } from "./support/accounts";
import { NOW, seedConnection } from "./support/connections";
import { ORIGIN } from "./support/worker";

it("opens records in place with their stored details and navigates to an account filter in Chromium", async () => {
  const f = await activityFixture();
  const source = await seedAccount({ name: "Northwind", email: "alex@northwind.example" });
  const removed = await seedAccount({
    name: "Old work",
    email: "old@example.com",
    state: "removed",
    removed_at: NOW - 86400000,
    access_token: null,
    refresh_token: null,
  });
  const ended = await seedConnection({
    name: "Old laptop",
    state: "revoked",
    revoked_at: NOW - 86400000,
  });
  const copied = await record(f.connection.id, f.account.id, {
    tool: "send_message",
    also: [
      { account: source.id, tool: "get_attachment" },
      { account: removed.id, tool: "get_attachment" },
    ],
  });
  await approval(copied, f.connection.id, "approved");
  const rejected = await record(ended.id, removed.id, { outcome: "rejected" });
  await approval(rejected, ended.id, "rejected");
  await record(f.connection.id, null, { tool: "list_accounts" });
  await record(f.connection.id, null, { tool: "read_thread", outcome: "refused" });
  await record(f.connection.id, null, { tool: null, outcome: "refused" });
  const initial = await f.browser.get("/activity");
  const filteredPath = `/activity?account=${source.id}`;
  const filtered = await f.browser.get(filteredPath);
  const result = await (
    await (env as TestEnv).TEST_BROWSER.fetch("http://browser/hydrate", {
      method: "POST",
      body: JSON.stringify({
        url: `${ORIGIN}/activity`,
        html: await initial.text(),
        headers: Object.fromEntries(initial.headers),
        width: 390,
        activity: {
          url: `${ORIGIN}${filteredPath}`,
          html: await filtered.text(),
          headers: Object.fromEntries(filtered.headers),
        },
      }),
    })
  ).json<{
    clientLoads: number;
    initialRows: number;
    details: string[];
    urls: string[];
    filteredUrl: string;
    filteredRows: number;
    topBefore: number;
    topAfter: number;
    overflow: boolean;
    errors: string[];
  }>();
  expect(result.errors).toEqual([]);
  expect(result.clientLoads).toBe(2);
  expect(result.initialRows).toBe(5);
  expect(result.details[0]).toContain("The agent called a tool that this server does not have.");
  expect(result.details[1]).toContain("None. The call named no connected account.");
  expect(result.details[2]).toContain("None. This tool acts on no account.");
  expect(result.details[2]).toContain("list_accounts");
  expect(result.details[3]).toContain("You removed this account on Nov 8.");
  expect(result.details[3]).toContain("Ended: Revoked Nov 8");
  expect(result.details[3]).toContain("You rejected it on Sat, Nov 9, 2030 at 11:59 UTC");
  expect(result.details[4]).toContain("send_message");
  expect(result.details[4]).toContain("alex.personal@example.com");
  expect(result.details[4]).toContain("Download attachment on Northwind");
  expect(result.details[4]).toContain("Download attachment on Old work");
  expect(result.details[4]).toContain("Claude Code");
  expect(result.details[4]).toContain("Sat, Nov 9, 2030 at 12:00 UTC");
  expect(result.details[4]).toContain("You approved it on Sat, Nov 9, 2030 at 11:59 UTC");
  expect(result.urls).toEqual(Array(5).fill(`${ORIGIN}/activity`));
  expect(result.filteredUrl).toBe(`${ORIGIN}${filteredPath}`);
  expect(result.filteredRows).toBe(1);
  expect(result.topAfter).toBe(result.topBefore);
  expect(result.overflow).toBe(false);
}, 30000);

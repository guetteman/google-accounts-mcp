import { env } from "cloudflare:workers";
import { expect, it } from "vite-plus/test";
import "./support/account-checks";
import type { TestEnv } from "./env";
import { fixture, permission } from "./support/permissions";
import { ORIGIN } from "./support/worker";

it("hydrates the Worker's connection page once and collapses an account without making a request", async () => {
  const f = await fixture();
  await permission(f);
  const response = await f.mcp.browser.get(`/connections/${f.connection.id}`);
  expect(response.status).toBe(200);
  const html = await response.text();
  for (const account of [f.personal, f.northwind])
    expect(html).toContain(`aria-label="List labels on ${account.name} for Claude"`);
  const hydrated = await (
    await (env as TestEnv).TEST_BROWSER.fetch("http://browser/hydrate", {
      method: "POST",
      body: JSON.stringify({
        url: `${ORIGIN}/connections/${f.connection.id}`,
        html,
        headers: Object.fromEntries(response.headers),
        connection: true,
      }),
    })
  ).json<{
    clientLoads: number;
    controls: Array<{ name: string; selected: string }>;
    collapsed: boolean;
    errors: string[];
  }>();
  expect(hydrated.errors).toEqual([]);
  expect(hydrated.clientLoads).toBe(1);
  expect(hydrated.controls).toEqual([
    { name: "List labels on Personal for Claude", selected: "Allowed" },
    { name: "List labels on Northwind for Claude", selected: "Not allowed" },
  ]);
  expect(hydrated.collapsed).toBe(true);
}, 30_000);

import { env } from "cloudflare:workers";
import { expect, it } from "vite-plus/test";
import "./support/account-checks";
import type { TestEnv } from "./env";
import { fixture, permission } from "./support/permissions";
import { ORIGIN } from "./support/worker";
import type { FramePage } from "../src/pages/page";

it("hydrates the Worker's connection page once and collapses an account without making a request", async () => {
  const f = await fixture();
  await permission(f);
  const response = await f.mcp.browser.get(`/connections/${f.connection.id}`);
  expect(response.status).toBe(200);
  const html = await response.text();
  const props = JSON.parse(
    /<script\b[^>]*id="page-props"[^>]*>([\s\S]*?)<\/script>/i.exec(html)![1]!,
  ) as Extract<FramePage, { _tag: "Connection" }>;
  for (const tool of props.tools)
    expect(html).toContain(`aria-label="${tool.label} on Personal for Claude"`);
  expect(props.accounts.map((account) => account.id)).toEqual([f.personal.id, f.northwind.id]);
  for (const tool of props.tools)
    expect(props.settings[`${f.northwind.id}:${tool.name}`]).toBeUndefined();
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
  expect(hydrated.controls).toEqual(
    props.tools.map((tool) => ({
      name: `${tool.label} on Personal for Claude`,
      selected: { allow: "Allowed", ask: "Ask first", deny: "Not allowed" }[
        props.settings[`${f.personal.id}:${tool.name}`] ?? "deny"
      ],
    })),
  );
  expect(hydrated.collapsed).toBe(true);
}, 30_000);

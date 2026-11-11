import { env } from "cloudflare:workers";
import { expect, it } from "vite-plus/test";
import "./support/account-checks";
import { NOW } from "./support/accounts";
import { seedConnection } from "./support/connections";
import { fixture, permission, problemCases } from "./support/permissions";
import { textOf } from "./support/worker";

function pageProps(html: string) {
  const json = /<script\b[^>]*id="page-props"[^>]*>([\s\S]*?)<\/script>/i.exec(html)?.[1];
  expect(json, "the server must provide the real connection page's hydration props").toBeDefined();
  return JSON.parse(json!) as {
    _tag: string;
    accounts: Array<{ id: string }>;
    settings: Record<string, "ask" | "allow">;
  };
}

it("links each connection to its own permissions page and shows only the accounts it can see", async () => {
  const f = await fixture();
  await permission(f);
  const empty = await seedConnection();
  const list = await (await f.mcp.browser.get("/connections")).text();
  expect(textOf(list)).toContain("Can see");
  expect(list).toContain(`href="/connections/${f.connection.id}"`);
  expect(list).toContain(`href="/connections/${empty.id}"`);
  const claude = [...list.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].find((m) =>
    m[1]!.includes(f.connection.id),
  )?.[1];
  expect(claude).toBeDefined();
  expect(textOf(claude!)).toContain("Personal");
  expect(textOf(claude!)).not.toContain("Northwind");
  expect(textOf(list)).toMatch(/no access yet/i);
  const response = await f.mcp.browser.get(`/connections/${f.connection.id}`);
  expect(response.status).toBe(200);
  const html = await response.text();
  expect(textOf(html)).toContain("Claude can see Personal.");
  expect(textOf(html)).toContain("Tool permissions");
  const props = pageProps(html);
  expect(props._tag).toBe("Connection");
  expect(props.accounts.map((a) => a.id)).toEqual([f.personal.id, f.northwind.id]);
  expect(props.settings).toEqual({ [`${f.personal.id}:list_labels`]: "allow" });
  for (const account of [f.personal, f.northwind])
    expect(html).toContain(`aria-label="List labels on ${account.name} for Claude"`);
  const groups = [...html.matchAll(/role="radiogroup"[^>]*>([\s\S]*?)<\/div>/g)];
  expect(groups).toHaveLength(2);
  expect(groups[0]![1]).toMatch(
    /aria-checked="true"[^>]*aria-label="Allowed"|aria-label="Allowed"[^>]*aria-checked="true"/,
  );
  expect(groups[1]![1]).toMatch(
    /aria-checked="true"[^>]*aria-label="Not allowed"|aria-label="Not allowed"[^>]*aria-checked="true"/,
  );
});

it.each(["revoked", "expired"])(
  "shows a %s connection without permission controls",
  async (state) => {
    const f = await fixture();
    if (state === "revoked") await f.mcp.browser.post(`/connections/${f.connection.id}/revoke`);
    else
      await env.DB.prepare("UPDATE connections SET expires_at = ? WHERE id = ?")
        .bind(NOW, f.connection.id)
        .run();
    const response = await f.mcp.browser.get(`/connections/${f.connection.id}`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(textOf(html)).toMatch(/ended connection cannot be given access/i);
    expect(html).not.toContain('role="radiogroup"');
    expect(pageProps(html).accounts).toEqual([]);
  },
);

it("shows an empty connection page with one action leading to Accounts", async () => {
  const f = await fixture();
  await env.DB.prepare("DELETE FROM accounts").run();
  const response = await f.mcp.browser.get(`/connections/${f.connection.id}`);
  expect(response.status).toBe(200);
  const html = await response.text();
  expect(textOf(html)).toMatch(/no Google accounts/i);
  expect(html).not.toContain('role="radiogroup"');
  // The empty state has one action; navigation elsewhere also links to Accounts.
  const empty = /data-slot="empty"[\s\S]*?<\/main>/.exec(html)?.[0];
  expect(empty).toBeDefined();
  expect([...empty!.matchAll(/href="\/accounts"/g)]).toHaveLength(1);
});

it.each(problemCases)(
  "shows the Accounts wording for $status and still permits allowing the account",
  async ({ row, status }) => {
    const f = await fixture(row);
    const response = await f.mcp.browser.get(`/connections/${f.connection.id}`);
    expect(response.status).toBe(200);
    const html = await response.text();
    const text = textOf(html);
    const wording: Record<string, string> = {
      needs_reconnect: "Google stopped accepting this server's access. Reconnect to restore it.",
      blocked_by_admin:
        "The organization's admin blocked this app. The server checks again at most every 10 minutes, when an agent uses this account.",
      missing_access:
        "Google granted 0 of the 5 permissions Gmail needs. Reconnect and check every box.",
      unreadable: "Can't read its stored access. Check TOKEN_KEY.",
    };
    expect(text).toContain(wording[status]!);
    const accountSection = html.slice(
      html.indexOf("Tool permissions"),
      html.indexOf('aria-label="List labels on Personal for Claude"'),
    );
    expect(accountSection).toContain('href="/accounts"');
    expect(html).toContain('aria-label="List labels on Personal for Claude"');
    await permission(f);
  },
);

it("renames and revokes from the connection page using the existing action routes", async () => {
  const f = await fixture();
  expect((await f.mcp.browser.get(`/connections/${f.connection.id}`)).status).toBe(200);
  expect(
    await (
      await f.mcp.browser.post(`/connections/${f.connection.id}/name`, { name: "Personal agent" })
    ).json(),
  ).toEqual({ outcome: "ok" });
  const renamed = await (await f.mcp.browser.get(`/connections/${f.connection.id}`)).text();
  expect(textOf(renamed)).toContain("Personal agent");
  expect(await (await f.mcp.browser.post(`/connections/${f.connection.id}/revoke`)).json()).toEqual(
    { outcome: "ok" },
  );
  const revoked = await (await f.mcp.browser.get(`/connections/${f.connection.id}`)).text();
  expect(revoked).not.toContain('role="radiogroup"');
  expect(textOf(revoked)).toMatch(/ended connection cannot be given access/i);
});

it.each(["00000000-0000-4000-8000-000000000000", "not-an-id"])(
  "returns a private 404 for absent connection %s",
  async (id) => {
    const f = await fixture();
    const response = await f.mcp.browser.get(`/connections/${id}`);
    expect(response.status).toBe(404);
    const html = await response.text();
    for (const value of [
      "Claude",
      "Personal",
      "Northwind",
      f.personal.email,
      f.northwind.email,
      f.connection.id,
    ])
      expect(html).not.toContain(value);
  },
);

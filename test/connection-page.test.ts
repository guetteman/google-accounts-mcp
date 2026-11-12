import { env } from "cloudflare:workers";
import { expect, it } from "vite-plus/test";
import "./support/account-checks";
import { NOW } from "./support/accounts";
import { seedConnection } from "./support/connections";
import { fixture, permission, problemCases } from "./support/permissions";
import { textOf } from "./support/worker";
import type { FramePage } from "../src/pages/page";
import { previews } from "../src/pages/previews";
import { GROUPS } from "../src/mcp/groups";
import { TOOLS } from "../src/mcp/tools";

function pageProps(html: string) {
  const json = /<script\b[^>]*id="page-props"[^>]*>([\s\S]*?)<\/script>/i.exec(html)?.[1];
  expect(json, "the server must provide the real connection page's hydration props").toBeDefined();
  return JSON.parse(json!) as Extract<FramePage, { _tag: "Connection" }>;
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
  for (const tool of props.tools) {
    const control = new RegExp(
      `role="radiogroup"[^>]*aria-label="${tool.label} on Personal for Claude"[^>]*>([\\s\\S]*?)<\\/div>`,
    ).exec(html);
    expect(control).not.toBeNull();
    const setting = props.settings[`${f.personal.id}:${tool.name}`] ?? "deny";
    const label = { deny: "Not allowed", ask: "Ask first", allow: "Allowed" }[setting];
    const segment = [...control![1]!.matchAll(/<button\b[^>]*>/g)].find((match) =>
      match[0].includes(`aria-label="${label}"`),
    );
    expect(segment?.[0]).toContain('aria-checked="true"');
  }
  expect(props.accounts[1]).toMatchObject({ id: f.northwind.id, name: "Northwind" });
  for (const tool of props.tools)
    expect(props.settings[`${f.northwind.id}:${tool.name}`]).toBeUndefined();
});

it("renders every tool in its group, in tool-list order, and no empty group", async () => {
  const f = await fixture();
  const html = await (await f.mcp.browser.get(`/connections/${f.connection.id}`)).text();
  const props = pageProps(html);
  expect(props.tools.map(({ name, group }) => ({ name, group }))).toEqual([
    { name: "list_labels", group: "Find and read" },
    { name: "search_threads", group: "Find and read" },
    { name: "read_thread", group: "Find and read" },
    { name: "change_labels", group: "Organize" },
    { name: "create_draft", group: "Draft" },
    { name: "trash_messages", group: "Trash and delete" },
    { name: "restore_messages", group: "Trash and delete" },
    { name: "delete_messages", group: "Trash and delete" },
    { name: "get_attachment", group: "Download attachments" },
    { name: "send_message", group: "Send" },
    { name: "send_reply", group: "Send" },
    { name: "forward_message", group: "Send" },
    { name: "send_draft", group: "Send" },
  ]);
  expect(props.tools.find((tool) => tool.name === "change_labels")).toEqual({
    name: "change_labels",
    label: "Change labels",
    group: "Organize",
    irreversible: false,
    description:
      "Archive threads, mark them read or unread, and add or remove labels. It cannot move mail to the trash or to spam, or take it out.",
  });
  const first = html.slice(
    html.indexOf("Tool permissions"),
    html.indexOf('aria-label="All tools on Northwind'),
  );
  expect(textOf(first)).toContain("Find and read");
  expect(textOf(first)).toContain("Organize");
  expect(first.indexOf('aria-label="List labels on Personal')).toBeLessThan(
    first.indexOf('aria-label="Search mail on Personal'),
  );
  expect(first.indexOf('aria-label="Search mail on Personal')).toBeLessThan(
    first.indexOf('aria-label="Read thread on Personal'),
  );
  expect(textOf(first)).toContain("Send");
  expect(first.indexOf('aria-label="Create draft on Personal')).toBeLessThan(
    first.indexOf('aria-label="Send message on Personal'),
  );
  expect(first.indexOf('aria-label="Read thread on Personal')).toBeLessThan(
    first.indexOf('aria-label="Change labels on Personal'),
  );
  expect(textOf(first)).toContain("Draft");
  expect(first.indexOf('aria-label="Read thread on Personal')).toBeLessThan(
    first.indexOf('aria-label="Create draft on Personal'),
  );
  expect(textOf(first)).toContain("Download attachments");
  expect(first.indexOf('aria-label="Read thread on Personal')).toBeLessThan(
    first.indexOf('aria-label="Download attachment on Personal'),
  );
  expect(textOf(first).indexOf("Organize")).toBeLessThan(textOf(first).indexOf("Trash and delete"));
  expect(first.indexOf('aria-label="Move to trash on Personal')).toBeLessThan(
    first.indexOf('aria-label="Restore from trash on Personal'),
  );
  expect(first.indexOf('aria-label="Restore from trash on Personal')).toBeLessThan(
    first.indexOf('aria-label="Delete permanently on Personal'),
  );
  const usedGroups = new Set(props.tools.map((tool) => tool.group));
  for (const group of GROUPS.filter((group) => !usedGroups.has(group)))
    expect(textOf(html)).not.toContain(group);
});

it("keeps every connection preview's tool groups and settings aligned with the real page", async () => {
  const f = await fixture();
  const real = pageProps(await (await f.mcp.browser.get(`/connections/${f.connection.id}`)).text());
  for (const scenario of [
    "new-connection",
    "some-allowed",
    "all-allowed",
    "no-accounts",
    "ended-connection",
    "save-failed",
  ]) {
    const preview = previews[`connection-${scenario}`];
    if (preview?._tag !== "Connection") throw new Error("Expected a connection preview");
    expect(preview.tools).toEqual(real.tools);
    for (const [index, account] of preview.accounts.entries())
      for (const tool of real.tools) {
        const expected =
          scenario === "all-allowed"
            ? "allow"
            : ["some-allowed", "save-failed"].includes(scenario) && index === 0
              ? "ask"
              : ["some-allowed", "save-failed"].includes(scenario) &&
                  index === 2 &&
                  tool.name === "list_labels"
                ? "allow"
                : undefined;
        expect(preview.settings[`${account.id}:${tool.name}`]).toBe(expected);
      }
  }
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

it("names all five irreversible tools in page order", async () => {
  const f = await fixture();
  const html = await (await f.mcp.browser.get(`/connections/${f.connection.id}`)).text();
  const tools = pageProps(html).tools;
  expect(
    GROUPS.flatMap((group) =>
      tools
        .filter((tool) => tool.group === group && tool.irreversible)
        .map(({ name, label }) => ({ name, label })),
    ),
  ).toEqual([
    { name: "send_message", label: "Send message" },
    { name: "send_reply", label: "Send reply" },
    { name: "forward_message", label: "Forward message" },
    { name: "send_draft", label: "Send draft" },
    { name: "delete_messages", label: "Delete permanently" },
  ]);
  expect(tools.find((tool) => tool.name === "create_draft")!.irreversible).toBe(false);
});

it("tells the page which tools cannot be undone, from each tool's own declaration", async () => {
  const f = await fixture();
  const tool = TOOLS.find((tool) => tool.name === "search_threads")!;
  if (tool.kind !== "account") throw new Error("search_threads has a setting");
  const original = tool.irreversible;
  tool.irreversible = true;
  try {
    const html = await (await f.mcp.browser.get(`/connections/${f.connection.id}`)).text();
    const shown = pageProps(html).tools.map(({ name, irreversible }) => ({ name, irreversible }));
    expect(shown).toContainEqual({ name: "search_threads", irreversible: true });
    expect(shown).toEqual(
      TOOLS.flatMap((tool) =>
        tool.kind === "account" ? [{ name: tool.name, irreversible: tool.irreversible }] : [],
      ),
    );
  } finally {
    tool.irreversible = original;
  }
});

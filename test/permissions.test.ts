import { env } from "cloudflare:workers";
import { expect, it } from "vite-plus/test";
import "./support/account-checks";
import { finish, start, NOW } from "./support/accounts";
import { Browser } from "./support/browser";
import { resetOwner } from "./support/connections";
import { brokenDb, dump, observeStatements, statementFailingDb } from "./support/db";
import { rpcResult } from "./support/oauth";
import {
  callRows,
  expectError,
  fixture,
  googleTraffic,
  NORTHWIND,
  permission,
  permissionRows,
  PERSONAL,
  refusedMessage,
  textResult,
  toolCall,
} from "./support/permissions";
import { testEnv, textOf } from "./support/worker";

it("removes access on the very next call without reconnecting the agent", async () => {
  const f = await fixture();
  await permission(f);
  await permission(f, f.personal, false);
  const before = googleTraffic().length;
  expect(await rpcResult(await toolCall(f.mcp, "list_accounts"))).toEqual(textResult([]));
  await expectError(
    await toolCall(f.mcp, "list_labels", { account: PERSONAL }),
    "account_not_available",
    refusedMessage(PERSONAL),
  );
  expect(googleTraffic().slice(before)).toEqual([]);
});

it("does not restore a removed account's permissions when the same Google identity reconnects", async () => {
  const f = await fixture();
  await permission(f);
  expect(await (await f.mcp.browser.post(`/accounts/${f.personal.id}/remove`)).json()).toEqual({
    outcome: "ok",
  });
  const { url } = await start(f.mcp.browser);
  await finish(f.mcp.browser, url, { claims: { sub: f.personal.sub, email: PERSONAL } });
  const live = await env.DB.prepare("SELECT id FROM accounts WHERE state = 'live' AND email = ?")
    .bind(PERSONAL)
    .first<{ id: string }>();
  expect(live?.id).toBeTruthy();
  expect(live!.id).not.toBe(f.personal.id);
  expect(await rpcResult(await toolCall(f.mcp, "list_accounts"))).toEqual(textResult([]));
  await expectError(
    await toolCall(f.mcp, "list_labels", { account: PERSONAL }),
    "account_not_available",
    refusedMessage(PERSONAL),
  );
  expect(
    await (
      await f.mcp.browser.post(`/connections/${f.connection.id}/permissions`, {
        account: live!.id,
        tool: "list_labels",
        setting: "allow",
      })
    ).json(),
  ).toEqual({ outcome: "ok" });
  expect(JSON.stringify(await rpcResult(await toolCall(f.mcp, "list_accounts")))).toContain(
    PERSONAL,
  );
});

it.each(["revoked", "expired"])(
  "rejects a %s connection with HTTP 401 before recording or contacting Google",
  async (state) => {
    const f = await fixture();
    await permission(f);
    if (state === "revoked")
      expect(
        await (await f.mcp.browser.post(`/connections/${f.connection.id}/revoke`)).json(),
      ).toEqual({ outcome: "ok" });
    else
      await env.DB.prepare("UPDATE connections SET expires_at = ? WHERE id = ?")
        .bind(NOW, f.connection.id)
        .run();
    const before = await callRows();
    const traffic = googleTraffic().length;
    for (const name of ["list_accounts", "list_labels"])
      expect((await toolCall(f.mcp, name, { account: PERSONAL })).status).toBe(401);
    expect(await callRows()).toEqual(before);
    expect(googleTraffic().slice(traffic)).toEqual([]);
  },
);

it("clears permissions and call records on owner reset and exposes none to the next owner", async () => {
  const f = await fixture();
  await permission(f);
  await toolCall(f.mcp, "list_labels", { account: PERSONAL });
  expect(await permissionRows()).toHaveLength(1);
  expect(await callRows()).toHaveLength(1);
  await resetOwner();
  expect(await permissionRows()).toEqual([]);
  expect(await callRows()).toEqual([]);
  const next = new Browser();
  await next.authenticate({ email: "next.owner@example.com" });
  for (const path of ["/accounts", "/connections"]) {
    const response = await next.get(path, {
      env: testEnv({ OWNER_EMAIL: "next.owner@example.com" }),
    });
    expect(response.status).toBe(200);
    const html = await response.text();
    const props = JSON.parse(
      /<script\b[^>]*id="page-props"[^>]*>([\s\S]*?)<\/script>/i.exec(html)![1]!,
    ) as { accounts?: unknown[]; connections?: unknown[] };
    expect(path === "/accounts" ? props.accounts : props.connections).toEqual([]);
    for (const value of ["Personal", "Northwind", PERSONAL, NORTHWIND])
      expect(textOf(html)).not.toContain(value);
  }
});

it.each(["no Access token", "another origin", "MCP access token", "another signed-in user"])(
  "refuses permission writes from %s without changing D1",
  async (kind) => {
    const f = await fixture();
    const before = await dump();
    const browser = kind === "another origin" ? f.mcp.browser : new Browser();
    if (kind === "another signed-in user")
      await browser.authenticate({ email: "stranger@example.com" });
    const response = await browser.post(
      `/connections/${f.connection.id}/permissions`,
      { account: f.personal.id, tool: "list_labels", setting: "allow" },
      {
        ...(kind === "another origin" ? { origin: "https://attacker.example" } : {}),
        ...(kind === "MCP access token"
          ? { headers: { Authorization: `Bearer ${f.mcp.tokens!.access_token}` } }
          : {}),
      },
    );
    expect(response.ok).toBe(false);
    expect(await dump()).toEqual(before);
  },
);

it.each([
  "revoked",
  "expired",
  "removed account",
  "unknown connection",
  "unknown account",
  "unknown tool",
  "malformed",
])("refuses deny, ask and allow for %s without changing stored permissions", async (kind) => {
  const f = await fixture();
  await permission(f);
  let connectionId = f.connection.id;
  const fields = { account: f.personal.id as string, tool: "list_labels", setting: "allow" };
  if (kind === "revoked") await f.mcp.browser.post(`/connections/${connectionId}/revoke`);
  if (kind === "expired")
    await env.DB.prepare("UPDATE connections SET expires_at = ? WHERE id = ?")
      .bind(NOW, connectionId)
      .run();
  if (kind === "removed account") await f.mcp.browser.post(`/accounts/${fields.account}/remove`);
  if (kind === "unknown connection") connectionId = crypto.randomUUID();
  if (kind === "unknown account") fields.account = crypto.randomUUID();
  if (kind === "unknown tool") fields.tool = "send_everything";
  const before = await dump();
  for (const setting of ["deny", "ask", "allow"]) {
    const response = await f.mcp.browser.post(`/connections/${connectionId}/permissions`, {
      ...fields,
      setting: kind === "malformed" ? "toggle" : setting,
    });
    const expected = ["revoked", "expired"].includes(kind)
      ? "already_ended"
      : ["unknown tool", "malformed"].includes(kind)
        ? "invalid"
        : "not_found";
    expect(await response.json()).toEqual({ outcome: expected });
    expect(await dump()).toEqual(before);
  }
});

it("makes repeated allow and deny requests idempotent", async () => {
  const f = await fixture();
  for (const allowed of [true, false]) {
    await permission(f, f.personal, allowed);
    const once = await permissionRows();
    expect(once).toHaveLength(allowed ? 1 : 0);
    await permission(f, f.personal, allowed);
    expect(await permissionRows()).toEqual(once);
  }
});

it("applies the exact permission form to the agent's next account listing", async () => {
  const f = await fixture();
  await permission(f);
  for (const allowed of [true, false]) {
    await permission(f, f.northwind, allowed);
    const visible = [f.personal, ...(allowed ? [f.northwind] : [])].map((a) => ({
      account: a.email,
      name: a.name,
      services: { gmail: { status: "ready" } },
    }));
    expect(await rpcResult(await toolCall(f.mcp, "list_accounts"))).toEqual(textResult(visible));
  }
});

it.each([false, true])(
  "answers unknown when the permission write fails after commit=%s",
  async (committed) => {
    const f = await fixture();
    const pattern = /^\s*(?:INSERT(?:\s+OR\s+IGNORE)?\s+INTO|DELETE\s+FROM)\s+permissions\b/i;
    const db = committed
      ? observeStatements(
          env.DB,
          () => {},
          (sql) => {
            if (pattern.test(sql)) throw new Error("D1 response lost");
          },
        )
      : statementFailingDb(pattern);
    const response = await f.mcp.browser.post(
      `/connections/${f.connection.id}/permissions`,
      { account: f.personal.id, tool: "list_labels", setting: "allow" },
      { env: testEnv({ DB: db }) },
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ outcome: "unknown" });
    expect(await permissionRows()).toHaveLength(committed ? 1 : 0);
  },
);

it("returns the owner's unavailable HTML when D1 is down before a permission write", async () => {
  const f = await fixture();
  const before = await dump();
  const response = await f.mcp.browser.post(
    `/connections/${f.connection.id}/permissions`,
    { account: f.personal.id, tool: "list_labels", setting: "allow" },
    { env: testEnv({ DB: brokenDb() }) },
  );
  expect(response.status).toBe(503);
  expect(response.headers.get("Content-Type")).toContain("text/html");
  expect(await dump()).toEqual(before);
});

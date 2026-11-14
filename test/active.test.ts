import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import "./support/account-checks";
import { DAY, NOW, onlyConnection, resetOwner, rows } from "./support/connections";
import { brokenDb, dump, failingKv, kvDump, restoreKv, statementFailingDb } from "./support/db";
import { clients, expectOAuthError, McpClient } from "./support/oauth";
import { callRows, PERSONAL } from "./support/permissions";
import {
  allowedAttachment,
  blocks,
  CONTENT,
  fileError,
  MESSAGE,
  resourceBytes,
  serveAttachment,
} from "./support/attachment";
import { callWorker, ORIGIN, testEnv, textOf } from "./support/worker";

it("refuses a revoked connection even with stale KV while another connection keeps working", async () => {
  const revoked = await new McpClient().connect("Work laptop");
  const first = await onlyConnection();
  const other = await new McpClient().connect("Personal laptop");
  const stale = await kvDump();
  const response = await revoked.browser.post(`/connections/${first.id}/revoke`);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ outcome: "ok" });
  await restoreKv(stale);
  expect((await kvDump()).some((e) => e.name.startsWith(`grant:${first.id}:`))).toBe(true);
  const denied = await revoked.call();
  expect(denied.status).toBe(401);
  expect(denied.headers.get("WWW-Authenticate")).toContain('error="invalid_token"');
  await expectOAuthError(await revoked.refresh(), "invalid_grant");
  expect((await other.call()).status).toBe(200);
  await other.keepTokens(await other.refresh());
});

describe("ninety days without refreshing", () => {
  it.each([89, 91])(
    "handles a first refresh on day %s and shows the original expiry date",
    async (day) => {
      const clock = vi.spyOn(Date, "now").mockReturnValue(NOW);
      const mcp = await new McpClient().connect();
      expect((await onlyConnection()).expires_at).toBe(NOW + 90 * DAY);
      clock.mockReturnValue(NOW + day * DAY);
      if (day === 89) {
        await mcp.keepTokens(await mcp.refresh());
        expect((await mcp.call()).status).toBe(200);
        expect((await onlyConnection()).expires_at).toBe(NOW + 179 * DAY);
      } else {
        await expectOAuthError(await mcp.refresh(), "invalid_grant");
        await mcp.browser.authenticate();
        const page = textOf(await (await mcp.browser.get("/connections")).text());
        // Nov 9, 2030 + 90 days is Feb 7, 2031, the current fake-clock year.
        expect(page).toContain("Expired Feb 7");
        expect((await onlyConnection()).expires_at).toBe(NOW + 90 * DAY);
      }
    },
  );

  it("refuses an expired D1 connection while its access token and KV grant remain valid", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const mcp = await new McpClient().connect();
    expect((await mcp.call()).status).toBe(200);
    const row = await onlyConnection();
    await env.DB.prepare("UPDATE connections SET expires_at = ? WHERE id = ?")
      .bind(NOW - 1, row.id)
      .run();
    const beforeKv = await kvDump();
    expect(beforeKv.some((e) => e.name.startsWith("token:"))).toBe(true);
    expect((await mcp.call()).status).toBe(401);
    expect(await kvDump()).toEqual(beforeKv);
  });

  it("updates last used only on MCP calls and extends expiry only on refresh", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(NOW);
    const mcp = await new McpClient().connect();
    expect((await onlyConnection()).last_used_at).toBeNull();
    clock.mockReturnValue(NOW + 10_000);
    expect((await mcp.call()).status).toBe(200);
    const called = await onlyConnection();
    expect(called.last_used_at).toBe(NOW + 10_000);
    expect(called.expires_at).toBe(NOW + 90 * DAY);
    clock.mockReturnValue(NOW + DAY);
    await mcp.keepTokens(await mcp.refresh());
    const refreshed = await onlyConnection();
    expect(refreshed.last_used_at).toBe(called.last_used_at);
    expect(refreshed.expires_at).toBe(NOW + 91 * DAY);
  });
});

it.each(clients)(
  "takes the $app identity from the stored connection, never from the request",
  async (client) => {
    const f = await allowedAttachment(client);
    serveAttachment();
    await new McpClient().connect("Other laptop");
    const other = (await rows()).find((row) => row.id !== f.connection.id)!;
    // A forged identity names the other connection and the client that receives any file.
    const download = () =>
      f.mcp.call(
        "tools/call",
        undefined,
        {
          name: "get_attachment",
          arguments: { account: PERSONAL, message: MESSAGE, attachment: "2" },
          app: "claude-code",
          connectionId: other.id,
        },
        { "X-App": "claude-code", "X-Connection-Id": other.id },
      );
    const expectForm = async (app: string) => {
      const response = await download();
      if (app === "claude-code") expect(resourceBytes(await blocks(response))).toEqual(CONTENT);
      else
        await fileError(response, "attachment_not_readable", /This client cannot read "menu.pdf"/);
    };
    await expectForm(client.app);
    const changedApp = client.app === "claude-code" ? "chatgpt" : "claude-code";
    await env.DB.prepare("UPDATE connections SET app = ? WHERE id = ?")
      .bind(changedApp, f.connection.id)
      .run();
    await expectForm(changedApp);
    expect(await callRows()).toEqual([
      expect.objectContaining({ connection_id: f.connection.id, tool: "get_attachment" }),
      expect.objectContaining({ connection_id: f.connection.id, tool: "get_attachment" }),
    ]);
  },
);

it("refuses a grant whose connection row was deleted", async () => {
  const mcp = await new McpClient().connect();
  const row = await onlyConnection();
  await env.DB.prepare("DELETE FROM connections WHERE id = ?").bind(row.id).run();
  expect((await kvDump()).some((e) => e.name.startsWith("grant:"))).toBe(true);
  expect((await mcp.call()).status).toBe(401);
  await expectOAuthError(await mcp.refresh(), "invalid_grant");
});

it("leaves all data and grants intact during owner mismatch and resumes the pending consent", async () => {
  const mcp = await new McpClient().connect();
  const pending = new McpClient();
  await pending.authorize();
  const before = await dump();
  const locked = testEnv({ OWNER_EMAIL: "new.owner@example.com" });
  expect((await mcp.call(undefined, locked)).status).toBe(503);
  await expectOAuthError(await mcp.refresh(locked), "temporarily_unavailable");
  await expectOAuthError(
    await mcp.token({ grant_type: "authorization_code", code: "unused" }, locked),
    "temporarily_unavailable",
  );
  await expectOAuthError(
    await mcp.token({ token: mcp.tokens!.refresh_token }, locked),
    "temporarily_unavailable",
  );
  expect(await dump()).toEqual(before);
  await mcp.keepTokens(await mcp.refresh());
  await pending.approve();
  await pending.keepTokens(await pending.exchange());
  expect(await rows()).toHaveLength(2);
});

it.each(["connections only", "all D1"])(
  "refuses MCP and keeps refresh retryable during %s outage",
  async (failure) => {
    const mcp = await new McpClient().connect();
    const before = await dump();
    const unavailable = testEnv({
      DB: failure === "all D1" ? brokenDb() : statementFailingDb(/connections/),
    });
    expect((await mcp.call(undefined, unavailable)).status).toBe(503);
    await expectOAuthError(await mcp.refresh(unavailable), "temporarily_unavailable");
    expect(await dump()).toEqual(before);
    await mcp.keepTokens(await mcp.refresh());
    expect((await mcp.call()).status).toBe(200);
  },
);

it("turns every KV operation failure into service unavailable for MCP and tokens", async () => {
  const mcp = await new McpClient().connect();
  const down = testEnv({ OAUTH_KV: failingKv("all") });
  expect((await mcp.call(undefined, down)).status).toBe(503);
  await expectOAuthError(await mcp.refresh(down), "temporarily_unavailable");
  const pending = new McpClient();
  await pending.authorize();
  await pending.approve();
  await expectOAuthError(await pending.exchange(down), "temporarily_unavailable");
  expect(await rows()).toHaveLength(1);
});

it.each(["before grant save", "token put"])(
  "keeps the inserted row after KV fails at %s and treats the retry according to code consumption",
  async (window) => {
    const mcp = new McpClient();
    await mcp.authorize();
    await mcp.approve();
    // Arm every-operation failure only once redeem committed the row. Earlier reads of the
    // existing grant must succeed to reach the failure window immediately before saveGrant.
    const afterInsert = new Proxy(env.OAUTH_KV, {
      get(target, key) {
        const value: unknown = Reflect.get(target, key);
        if (typeof value !== "function") return value;
        return async (...args: unknown[]) => {
          if ((await rows()).length) throw new Error("KV unavailable after D1 insert");
          return Reflect.apply(value, target, args);
        };
      },
    });
    const kv = window === "token put" ? failingKv("token-put") : afterInsert;
    await expectOAuthError(
      await mcp.exchange(testEnv({ OAUTH_KV: kv })),
      "temporarily_unavailable",
    );
    const row = await onlyConnection();
    expect(row.state).toBe("active");
    if (window === "before grant save") {
      await mcp.keepTokens(await mcp.exchange());
      expect((await mcp.call()).status).toBe(200);
    } else {
      await expectOAuthError(await mcp.exchange(), "invalid_grant");
      expect((await kvDump()).filter((e) => e.name.startsWith(`grant:${row.id}:`))).toEqual([]);
    }
    expect(await onlyConnection()).toMatchObject({ id: row.id, state: "active" });
  },
);

it("removes all connections at reset and refuses old tokens and unfinished sign-ins", async () => {
  const connected = await new McpClient().connect();
  const page = new McpClient();
  await page.authorize();
  const code = new McpClient();
  await code.authorize();
  await code.approve();
  await resetOwner();
  expect(await rows()).toEqual([]);
  expect((await connected.call()).status).toBe(401);
  await expectOAuthError(await connected.refresh(), "invalid_grant");
  expect((await page.consent()).status).toBe(400);
  await expectOAuthError(await code.exchange(), "invalid_grant");
  await connected.browser.authenticate();
  const empty = textOf(await (await connected.browser.get("/connections")).text());
  expect(empty).toContain(
    "Add this server in Claude, Claude Code, or ChatGPT. Each app that signs in appears here.",
  );
  expect(await rows()).toEqual([]);
});

it("returns service unavailable through the gate even without a usable bearer token", async () => {
  expect((await callWorker(new Request(`${ORIGIN}/mcp`), testEnv({ DB: brokenDb() }))).status).toBe(
    503,
  );
});

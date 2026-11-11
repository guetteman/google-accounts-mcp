import { env } from "cloudflare:workers";
import { Effect, Result } from "effect";
import { expect, it, vi } from "vite-plus/test";
import "./support/account-checks";
import { readConfig } from "../src/config";
import { open } from "../src/seal";
import { scheduled } from "../src/approvals/scheduled";
import { NOW } from "./support/accounts";
import { observeStatements, statementFailingDb } from "./support/db";
import {
  callRows,
  expectError,
  fixture,
  googleTraffic,
  PERSONAL,
  problemCases,
  toolCall,
} from "./support/permissions";
import { ask, answer, rows, setting } from "./support/approvals";
import { testEnv } from "./support/worker";
import { readOwner } from "../src/owner/owner";
import { cleanupApprovals } from "../src/approvals/store";

it("stores ask and allow idempotently, deletes deny, and makes an ask-only account visible", async () => {
  const f = await fixture();
  for (const value of ["ask", "allow", "deny"] as const) {
    await setting(f, value);
    const once = (await env.DB.prepare("SELECT * FROM permissions").all()).results;
    expect(once).toEqual(
      value === "deny"
        ? []
        : [
            {
              connection_id: f.connection.id,
              account_id: f.personal.id,
              tool: "list_labels",
              ask: value === "ask" ? 1 : 0,
            },
          ],
    );
    await setting(f, value);
    expect((await env.DB.prepare("SELECT * FROM permissions").all()).results).toEqual(once);
  }
  await setting(f, "ask");
  expect(await answer(await toolCall(f.mcp, "list_accounts"))).toEqual([
    { account: PERSONAL, name: "Personal", services: { gmail: { status: "ready" } } },
  ]);
});
it("keeps pre-migration permissions allowed", async () => {
  await env.DB.prepare(
    "CREATE TABLE old_permissions (connection_id TEXT, account_id TEXT, tool TEXT)",
  ).run();
  await env.DB.prepare("INSERT INTO old_permissions VALUES ('c','a','list_labels')").run();
  // Execute the permission migration, changing only its table name for this isolated old table.
  const migrations = import.meta.glob<string>("../migrations/0005_approvals.sql", {
    query: "?raw",
    import: "default",
    eager: true,
  });
  const sql = Object.values(migrations)[0]!
    .split(";")[0]!
    .replace("ALTER TABLE permissions", "ALTER TABLE old_permissions");
  await env.DB.prepare(sql).run();
  expect(await env.DB.prepare("SELECT ask FROM old_permissions").first()).toEqual({ ask: 0 });
});
it("seals only decoded arguments, binds both purposes to their approval, and supports 256 KB", async () => {
  const f = await fixture();
  await setting(f, "ask");
  const id = await ask(f, { account: PERSONAL, ignored: "not stored" });
  const stored = (await rows())[0]!;
  expect(stored.uses).toBe(JSON.stringify([{ account: f.personal.id, tool: "list_labels" }]));
  const config = readConfig(testEnv());
  if (Result.isFailure(config)) throw new Error("Invalid config");
  expect(await open(config.success.tokenKey, `${id}:arguments`, stored.arguments!)).toEqual({
    ok: true,
    value: JSON.stringify({ account: PERSONAL }),
  });
  for (const context of [`${crypto.randomUUID()}:arguments`, `${id}:result`])
    expect((await open(config.success.tokenKey, context, stored.arguments!)).ok).toBe(false);
  const { seal } = await import("../src/seal");
  const large = "é".repeat(256 * 1024);
  const sealed = await seal(config.success.tokenKey, `${id}:arguments`, large);
  expect(await open(config.success.tokenKey, `${id}:arguments`, sealed)).toEqual({
    ok: true,
    value: large,
  });
});
it("rejects invalid and oversized decoded arguments before creating an approval", async () => {
  const f = await fixture();
  await setting(f, "ask");
  const before = googleTraffic().length;
  for (const args of [
    undefined,
    {},
    { account: 42 },
    { account: "a".repeat(256 * 1024) + "@example.com" },
  ])
    await expectError(await toolCall(f.mcp, "list_labels", args), "invalid_arguments", /./);
  expect(await rows()).toEqual([]);
  expect(googleTraffic().slice(before)).toEqual([]);
});
it.each(problemCases)(
  "checks $status without Google before asking",
  async ({ row: overrides, status, message }) => {
    const f = await fixture(overrides);
    await setting(f, "ask");
    const before = googleTraffic().length;
    if (status === "blocked_by_admin") await ask(f);
    else
      await expectError(
        await toolCall(f.mcp, "list_labels", { account: PERSONAL }),
        `account_${status}`,
        message,
      );
    expect(await rows()).toHaveLength(status === "blocked_by_admin" ? 1 : 0);
    expect(googleTraffic().slice(before)).toEqual([]);
  },
);
it("admits exactly 20 of 40 concurrent ask calls and audits the other 20 as refused", async () => {
  const f = await fixture();
  await setting(f, "ask");
  const responses = await Promise.all(
    Array.from({ length: 40 }, () => toolCall(f.mcp, "list_labels", { account: PERSONAL })),
  );
  const bodies = await Promise.all(
    responses.map(async (response) => {
      const { rpcResult } = await import("./support/oauth");
      const result = await rpcResult(response);
      return JSON.parse((result.content as { text: string }[])[0]!.text) as {
        status?: string;
        code?: string;
      };
    }),
  );
  expect(bodies.filter((body) => body.status === "pending")).toHaveLength(20);
  expect(bodies.filter((body) => body.code === "approval_limit_reached")).toHaveLength(20);
  expect(await rows()).toHaveLength(20);
  const calls = await callRows();
  expect(calls.filter((call) => call.outcome === "pending")).toHaveLength(20);
  expect(calls.filter((call) => call.outcome === "refused")).toHaveLength(20);
});
it("rolls back approval creation if the pending audit write fails", async () => {
  const f = await fixture();
  await setting(f, "ask");
  await env.DB.prepare(
    "CREATE TRIGGER fail_pending BEFORE UPDATE OF outcome ON calls WHEN NEW.outcome = 'pending' BEGIN SELECT RAISE(ABORT, 'test rollback'); END",
  ).run();
  await expectError(
    await toolCall(f.mcp, "list_labels", { account: PERSONAL }),
    "server_unavailable",
    /./,
  );
  expect(await rows()).toEqual([]);
  expect((await callRows())[0]!.outcome).toBeNull();
});
it.each([false, true])(
  "never closes the creating call after its batch response is lost, committed=%s",
  async (committed) => {
    const f = await fixture();
    await setting(f, "ask");
    const pattern = /INSERT INTO approvals/;
    const db = committed
      ? observeStatements(
          env.DB,
          () => {},
          (sql) => {
            if (pattern.test(sql)) throw new Error("lost response");
          },
        )
      : statementFailingDb(pattern);
    await expectError(
      await toolCall(f.mcp, "list_labels", { account: PERSONAL }, testEnv({ DB: db })),
      "server_unavailable",
      /./,
    );
    expect(await rows()).toHaveLength(committed ? 1 : 0);
    expect((await callRows())[0]!.outcome).toBe(committed ? "pending" : null);
    vi.spyOn(Date, "now").mockReturnValue(NOW + 3_600_000);
    await scheduled({} as ScheduledController, testEnv());
    expect((await callRows())[0]!.outcome).toBe(committed ? "expired" : null);
    if (committed) expect((await rows())[0]).toMatchObject({ state: "expired", arguments: null });
  },
);
it.each(["deny", "remove", "revoke"])(
  "refuses creation when %s wins between the account read and creation",
  async (action) => {
    const f = await fixture();
    await setting(f, "ask");
    let raced = false;
    const db = observeStatements(env.DB, async (sql) => {
      if (raced || !/INSERT INTO approvals/.test(sql)) return;
      raced = true;
      if (action === "deny") await setting(f, "deny");
      else
        await f.mcp.browser.post(
          action === "remove"
            ? `/accounts/${f.personal.id}/remove`
            : `/connections/${f.connection.id}/revoke`,
        );
    });
    await expectError(
      await toolCall(f.mcp, "list_labels", { account: PERSONAL }, testEnv({ DB: db })),
      "account_not_available",
      /./,
    );
    expect(raced).toBe(true);
    expect(await rows()).toEqual([]);
    expect((await callRows())[0]!.outcome).toBe("refused");
  },
);
it("does not count expired approvals toward the waiting limit", async () => {
  const f = await fixture();
  await setting(f, "ask");
  await Promise.all(Array.from({ length: 20 }, () => ask(f)));
  await env.DB.prepare("UPDATE approvals SET expires_at = ?").bind(NOW).run();
  await ask(f);
  expect(await rows()).toHaveLength(21);
  const owner = await Effect.runPromise(readOwner(env.DB));
  await Effect.runPromise(
    cleanupApprovals(
      { db: env.DB, owner: { generation: owner.generation, email: owner.email! } },
      NOW,
    ),
  );
  expect((await rows()).filter((row) => row.state === "waiting")).toHaveLength(1);
});

it.each([0, 1, null, 2, "0"])(
  "runs without approval only for the numeric allow setting, ask=%s",
  async (askValue) => {
    const f = await fixture();
    await setting(f, "allow");
    const db = new Proxy(env.DB, {
      get(target, key) {
        if (key === "batch")
          return async (statements: D1PreparedStatement[]) => {
            const results = await target.batch<Record<string, unknown>>(statements);
            for (const batch of results)
              for (const row of batch.results) if (Object.hasOwn(row, "ask")) row.ask = askValue;
            return results;
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const before = googleTraffic().length;
    const result = await answer(
      await toolCall(f.mcp, "list_labels", { account: PERSONAL }, testEnv({ DB: db })),
    );
    if (askValue === 0) {
      expect(result).toHaveProperty("labels");
      expect(await rows()).toEqual([]);
    } else {
      expect(result.status).toBe("pending");
      expect(await rows()).toHaveLength(1);
      expect(googleTraffic().slice(before)).toEqual([]);
    }
  },
);

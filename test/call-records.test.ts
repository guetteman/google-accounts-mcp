import { env } from "cloudflare:workers";
import { Effect } from "effect";
import { expect, it, vi } from "vite-plus/test";
import { HttpResponse } from "msw";
import "./support/account-checks";
import { seedAccount, NOW } from "./support/accounts";
import { dump, observeStatements, statementFailingDb } from "./support/db";
import { google, LABELS_RESPONSE, SCOPES } from "./support/google";
import { rpcMessages } from "./support/oauth";
import {
  callRows,
  expectError,
  fixture,
  googleTraffic,
  NORTHWIND,
  permission,
  PERSONAL,
  SERVER_MESSAGE,
  refusedMessage,
  textResult,
  toolCall,
} from "./support/permissions";
import { testEnv } from "./support/worker";

it.each(["list_labels", "list_accounts"])(
  "fails closed without a record or Google request when recording %s fails",
  async (name) => {
    const f = await fixture();
    if (name === "list_labels") await permission(f);
    const before = googleTraffic().length;
    const db = statementFailingDb(/\bINSERT\s+INTO\s+calls\b/i);
    await expectError(
      await toolCall(f.mcp, name, { account: PERSONAL }, testEnv({ DB: db })),
      "server_unavailable",
      SERVER_MESSAGE,
    );
    expect(await callRows()).toEqual([]);
    expect(googleTraffic().slice(before)).toEqual([]);
  },
);

const gmailModules = import.meta.glob<{ listLabels: (...args: unknown[]) => unknown }>(
  "../src/google/gmail.ts",
);
it.each(["thrown error", "Effect defect"])(
  "contains an unexpected Gmail module %s and records failure without exposing internal text",
  async (failure) => {
    const load = gmailModules["../src/google/gmail.ts"];
    expect(load, "the accepted Gmail module must exist").toBeDefined();
    const gmail = await load!();
    const f = await fixture();
    await permission(f);
    vi.spyOn(gmail, "listLabels").mockImplementation(() => {
      if (failure === "thrown error") throw new Error("PRIVATE_INTERNAL_EXCEPTION");
      return Effect.die(new Error("PRIVATE_INTERNAL_EXCEPTION"));
    });
    await expectError(
      await toolCall(f.mcp, "list_labels", { account: PERSONAL }),
      "server_unavailable",
      SERVER_MESSAGE,
    );
    expect(await callRows()).toEqual([
      expect.objectContaining({ account_id: f.personal.id, outcome: "failed" }),
    ]);
  },
);

it("records each known, refused and failed call with only its resolved account and server tool name", async () => {
  const f = await fixture();
  await permission(f);
  await seedAccount({
    email: "removed@example.com",
    state: "removed",
    removed_at: NOW,
    access_token: null,
    refresh_token: null,
    access_expires_at: null,
  });
  const rows: Array<{
    name: string;
    args?: Record<string, unknown>;
    account: string | null;
    tool: string | null;
    outcome: string | null;
    answer?: () => Response;
    problem?: boolean;
    serverFailure?: boolean;
    removed?: boolean;
  }> = [
    { name: "list_accounts", account: null, tool: "list_accounts", outcome: "success" },
    {
      name: "list_labels",
      args: { account: PERSONAL },
      account: f.personal.id,
      tool: "list_labels",
      outcome: "success",
    },
    {
      name: "list_labels",
      args: { account: NORTHWIND },
      account: f.northwind.id,
      tool: "list_labels",
      outcome: "refused",
    },
    ...["removed@example.com", "nobody@example.com", "Personal"].map((account) => ({
      name: "list_labels",
      args: { account },
      account: null,
      tool: "list_labels",
      outcome: "refused",
    })),
    ...[undefined, { account: 42 }, { account: [] }, { account: null }].map((args) => ({
      name: "list_labels",
      args,
      account: null,
      tool: "list_labels",
      outcome: "refused",
    })),
    { name: "not_a_tool", account: null, tool: null, outcome: "refused" },
    {
      name: "list_labels",
      args: { account: PERSONAL },
      account: f.personal.id,
      tool: "list_labels",
      outcome: "failed",
      answer: () => new HttpResponse(null, { status: 503 }),
    },
    {
      name: "list_labels",
      args: { account: PERSONAL },
      account: f.personal.id,
      tool: "list_labels",
      outcome: null,
      answer: () => HttpResponse.error(),
    },
    {
      name: "list_labels",
      args: { account: PERSONAL },
      account: f.personal.id,
      tool: "list_labels",
      outcome: "failed",
      problem: true,
    },
    {
      name: "list_labels",
      args: { account: PERSONAL },
      account: f.personal.id,
      tool: "list_labels",
      outcome: "failed",
      serverFailure: true,
    },
    {
      name: "list_labels",
      args: { account: PERSONAL },
      account: f.personal.id,
      tool: "list_labels",
      outcome: "refused",
      removed: true,
    },
  ];
  const expected: unknown[] = [];
  for (const row of rows) {
    let restore: (() => void) | undefined;
    if (row.problem)
      await env.DB.prepare("UPDATE accounts SET scopes = '[]' WHERE id = ?")
        .bind(f.personal.id)
        .run();
    if (row.serverFailure) {
      const load = gmailModules["../src/google/gmail.ts"];
      expect(load).toBeDefined();
      const spy = vi.spyOn(await load!(), "listLabels").mockImplementation(() => {
        throw new Error("PRIVATE_INTERNAL_EXCEPTION");
      });
      restore = () => spy.mockRestore();
    }
    if (row.removed) {
      await env.DB.prepare("UPDATE accounts SET access_expires_at = ? WHERE id = ?")
        .bind(NOW, f.personal.id)
        .run();
      google.refreshAnswers.push(async () => {
        const recorded = await callRows();
        expect(recorded).toHaveLength(expected.length + 1);
        expect(recorded.at(-1)).toMatchObject({ outcome: null, account_id: f.personal.id });
        expect(
          await (await f.mcp.browser.post(`/accounts/${f.personal.id}/remove`)).json(),
        ).toEqual({ outcome: "ok" });
        return HttpResponse.json({
          access_token: "refreshed-test-access",
          expires_in: 3600,
          token_type: "Bearer",
        });
      });
    }
    if (
      row.name === "list_labels" &&
      row.account === f.personal.id &&
      !row.problem &&
      !row.serverFailure &&
      !row.removed
    )
      google.labelAnswers.push(async () => {
        const recorded = await callRows();
        expect(recorded).toHaveLength(expected.length + 1);
        expect(recorded.at(-1)).toMatchObject({
          connection_id: f.connection.id,
          account_id: f.personal.id,
          tool: "list_labels",
          at: NOW,
          outcome: null,
        });
        return row.answer?.() ?? HttpResponse.json(LABELS_RESPONSE);
      });
    const { messages } = await rpcMessages(await toolCall(f.mcp, row.name, row.args));
    expect(messages).toHaveLength(1);
    expected.push({
      id: expect.any(Number),
      connection_id: f.connection.id,
      account_id: row.account,
      tool: row.tool,
      at: NOW,
      outcome: row.outcome,
    });
    expect(await callRows()).toEqual(expected);
    restore?.();
    if (row.problem)
      await env.DB.prepare("UPDATE accounts SET scopes = ? WHERE id = ?")
        .bind(JSON.stringify(SCOPES), f.personal.id)
        .run();
  }
});

it("never persists arbitrary tool names or arguments in any table", async () => {
  const f = await fixture();
  const { messages } = await rpcMessages(
    await toolCall(f.mcp, "send_everything", { account: "PRIVATE-MARKER", q: "PRIVATE-MARKER" }),
  );
  expect(messages[0]?.error?.code).toBe(-32602);
  const stored = JSON.stringify(await dump());
  expect(stored).not.toContain("send_everything");
  expect(stored).not.toContain("PRIVATE-MARKER");
});

it("records both calls in a legacy JSON-RPC batch", async () => {
  const f = await fixture();
  const { messages } = await rpcMessages(
    await f.mcp.raw(
      [1, 2].map((id) => ({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name: "list_accounts" },
      })),
    ),
  );
  expect(messages.map((m) => m.id).sort((a, b) => a! - b!)).toEqual([1, 2]);
  for (const message of messages) expect(message.result).toEqual(textResult([]));
  expect(await callRows()).toEqual(
    [1, 2].map(() => ({
      id: expect.any(Number),
      connection_id: f.connection.id,
      account_id: null,
      tool: "list_accounts",
      at: NOW,
      outcome: "success",
    })),
  );
});

it("reports server unavailable and retains an unknown outcome if closing the record fails", async () => {
  const f = await fixture();
  await permission(f);
  await expectError(
    await toolCall(
      f.mcp,
      "list_labels",
      { account: PERSONAL },
      testEnv({ DB: statementFailingDb(/\bUPDATE\s+calls\b/i) }),
    ),
    "server_unavailable",
    SERVER_MESSAGE,
  );
  expect(google.labelRequests).toHaveLength(1);
  expect(await callRows()).toEqual([
    expect.objectContaining({ account_id: f.personal.id, outcome: null }),
  ]);
});

it("does not contact Google when D1 commits the record but loses the batch response", async () => {
  const f = await fixture();
  await permission(f);
  let injected = false;
  const db = observeStatements(
    env.DB,
    () => {},
    (sql) => {
      if (!injected && /\bINSERT\s+INTO\s+calls\b/i.test(sql)) {
        injected = true;
        throw new Error("D1 response lost");
      }
    },
  );
  const before = googleTraffic().length;
  await expectError(
    await toolCall(f.mcp, "list_labels", { account: PERSONAL }, testEnv({ DB: db })),
    "server_unavailable",
    SERVER_MESSAGE,
  );
  expect(injected).toBe(true);
  expect(googleTraffic().slice(before)).toEqual([]);
  expect(await callRows()).toEqual([expect.objectContaining({ outcome: null })]);
});

it.each([
  { label: "scalar arguments", params: { name: "list_labels", arguments: 42 } },
  { label: "array arguments", params: { name: "list_labels", arguments: [] } },
  { label: "null arguments", params: { name: "list_labels", arguments: null } },
  { label: "missing name", params: { arguments: {} } },
  { label: "numeric name", params: { name: 42 } },
  { label: "notification", params: { name: "list_accounts" }, notification: true },
])(
  "does not execute or record an SDK-rejected request with $label",
  async ({ params, notification }) => {
    const f = await fixture();
    const before = await dump();
    const traffic = googleTraffic().length;
    const writes: string[] = [];
    const db = observeStatements(env.DB, (sql) => {
      if (/\b(?:INSERT\s+INTO|UPDATE)\s+calls\b/i.test(sql)) writes.push(sql);
    });
    const response = await f.mcp.raw(
      { jsonrpc: "2.0", ...(notification ? {} : { id: 1 }), method: "tools/call", params },
      testEnv({ DB: db }),
    );
    if (notification) expect(response.status).toBe(202);
    else {
      const { messages } = await rpcMessages(response);
      expect(messages[0]?.error).toBeDefined();
    }
    expect(writes).toEqual([]);
    expect((await dump()).calls).toEqual(before.calls);
    expect(googleTraffic().slice(traffic)).toEqual([]);
  },
);

it("fails closed when the owner revokes the connection between checking it and recording the call", async () => {
  const f = await fixture();
  await permission(f);
  let revoked = false;
  const db = observeStatements(env.DB, async (sql) => {
    if (!revoked && /\bINSERT\s+INTO\s+calls\b/i.test(sql)) {
      revoked = true;
      expect(
        await (await f.mcp.browser.post(`/connections/${f.connection.id}/revoke`)).json(),
      ).toEqual({ outcome: "ok" });
    }
  });
  const before = googleTraffic().length;
  await expectError(
    await toolCall(f.mcp, "list_labels", { account: PERSONAL }, testEnv({ DB: db })),
    "server_unavailable",
    SERVER_MESSAGE,
  );
  expect(revoked).toBe(true);
  expect(await callRows()).toEqual([]);
  expect(googleTraffic().slice(before)).toEqual([]);
});

it("cannot overwrite a new owner's reused record ID with an outcome from before reset", async () => {
  const { resetOwner } = await import("./support/connections");
  const { McpClient } = await import("./support/oauth");
  const { deferred } = await import("./support/google");
  const f = await fixture();
  await permission(f);
  const entered = deferred();
  const release = deferred();
  google.labelAnswers.push(async () => {
    entered.resolve();
    await release.promise;
    return HttpResponse.json(LABELS_RESPONSE);
  });
  const pending = toolCall(f.mcp, "list_labels", { account: PERSONAL });
  try {
    await Promise.race([
      entered.promise,
      pending.then(() => {
        throw new Error("Call ended without reaching Gmail");
      }),
    ]);
    const old = (await callRows())[0]!;
    await resetOwner();
    const next = await new McpClient().connect("Next owner connection");
    await expectError(
      await toolCall(next, "list_labels", { account: "nobody@example.com" }),
      "account_not_available",
      refusedMessage("nobody@example.com"),
    );
    const fresh = await callRows();
    expect(fresh).toHaveLength(1);
    expect(fresh[0]!.id).toBe(old.id);
    expect(fresh[0]!.outcome).toBe("refused");
    expect(fresh[0]!.connection_id).not.toBe(old.connection_id);
    release.resolve();
    await pending;
    expect(await callRows()).toEqual(fresh);
  } finally {
    release.resolve();
    await pending;
  }
});

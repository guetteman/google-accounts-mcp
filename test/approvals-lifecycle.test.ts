import { env } from "cloudflare:workers";
import { Effect } from "effect";
import { expect, it, vi } from "vite-plus/test";
import "./support/account-checks";
import {
  cleanupApprovals,
  decideApproval,
  finishApproval,
  readApproval,
} from "../src/approvals/store";
import { parseApprovalId } from "../src/approvals/model";
import { readOwner } from "../src/owner/owner";
import { scheduled } from "../src/approvals/scheduled";
import { NOW, fixtureOpen } from "./support/accounts";
import { resetOwner } from "./support/connections";
import { observeStatements, dump, setOwner } from "./support/db";
import { google, deferred, LABELS_RESPONSE } from "./support/google";
import { callRows, fixture, expectError, toolCall } from "./support/permissions";
import {
  ask,
  approve,
  decided,
  digest,
  get,
  page,
  post,
  row,
  rows,
  setting,
  observeDecisions,
} from "./support/approvals";
import { OWNER_EMAIL, testEnv } from "./support/worker";
import { McpClient } from "./support/oauth";
const context = async () => {
  const owner = await Effect.runPromise(readOwner(env.DB));
  return { db: env.DB, owner: { generation: owner.generation, email: owner.email! } };
};
const end = async (f: Awaited<ReturnType<typeof fixture>>, by: string) => {
  if (by === "tool") return setting(f, "deny");
  const response = await f.mcp.browser.post(
    by === "account"
      ? `/accounts/${f.personal.id}/remove`
      : `/connections/${f.connection.id}/revoke`,
  );
  expect(await response.json()).toEqual({ outcome: "ok" });
};
it.each(["tool", "connection", "account"])(
  "ends waiting approvals and purges decided text atomically on %s",
  async (by) => {
    const f = await fixture();
    await setting(f, "ask");
    const completed = await ask(f);
    await approve(f, completed);
    const waiting = await ask(f),
      expired = await ask(f);
    await env.DB.prepare("UPDATE approvals SET expires_at = ? WHERE id = ?")
      .bind(NOW, expired)
      .run();
    expect((await row(completed))!.result).not.toBeNull();
    await end(f, by);
    expect(await row(waiting)).toMatchObject({
      state: "refused",
      ended_by: by,
      arguments: null,
    });
    expect(await row(expired)).toMatchObject({
      state: "expired",
      ended_by: null,
      arguments: null,
    });
    expect(await row(completed)).toMatchObject({
      state: "approved",
      outcome: "success",
      result: null,
    });
    const calls = await callRows();
    for (const [id, outcome] of [
      [waiting, "refused"],
      [expired, "expired"],
      [completed, "success"],
    ] as const)
      expect(
        calls.find((call) => call.id === (id === waiting ? 2 : id === expired ? 3 : 1)),
      ).toMatchObject({ outcome, reason: null });
    expect((await page(f, waiting)).state).toEqual({ kind: "ended", by });
    const html = await (await f.mcp.browser.get(`/approvals/${waiting}`)).text();
    expect(html).not.toContain(">Approve</button>");
    expect(html).not.toContain(">Reject</button>");
  },
);
it.each(["tool", "connection", "account"])(
  "rolls back purging and the owner's %s change together",
  async (by) => {
    const f = await fixture();
    await setting(f, "ask");
    const id = await ask(f);
    const before = await row(id);
    await env.DB.prepare(
      "CREATE TRIGGER fail_purge BEFORE UPDATE OF arguments ON approvals WHEN OLD.arguments IS NOT NULL AND NEW.arguments IS NULL BEGIN SELECT RAISE(ABORT, 'test rollback'); END",
    ).run();
    const path =
      by === "tool"
        ? `/connections/${f.connection.id}/permissions`
        : by === "connection"
          ? `/connections/${f.connection.id}/revoke`
          : `/accounts/${f.personal.id}/remove`;
    const response = await f.mcp.browser.post(
      path,
      by === "tool" ? { account: f.personal.id, tool: "list_labels", setting: "deny" } : {},
    );
    expect(response.status).toBe(503);
    expect(await row(id)).toEqual(before);
    expect((await callRows())[0]!.outcome).toBe("pending");
    expect(
      await env.DB.prepare("SELECT state FROM accounts WHERE id = ?").bind(f.personal.id).first(),
    ).toEqual({ state: "live" });
    expect(
      await env.DB.prepare("SELECT state FROM connections WHERE id = ?")
        .bind(f.connection.id)
        .first(),
    ).toEqual({ state: "active" });
    expect(
      await env.DB.prepare("SELECT ask FROM permissions WHERE account_id = ?")
        .bind(f.personal.id)
        .first(),
    ).toEqual({ ask: 1 });
  },
);
it("stores the result when deny then ask restore access before an approved run ends", async () => {
  const f = await fixture();
  await setting(f, "ask");
  const id = await ask(f);
  const d = await digest(f, id);
  const entered = deferred(),
    release = deferred();
  google.labelAnswers.push(async () => {
    entered.resolve();
    await release.promise;
    return Response.json(LABELS_RESPONSE);
  });
  const running = post(f, id, "approve", { digest: d });
  await entered.promise;
  await setting(f, "deny");
  await setting(f, "ask");
  release.resolve();
  expect((await decided(await running)).state.kind).toBe("succeeded");
  expect(await get(f, id)).toEqual({
    status: "success",
    result: {
      account: f.personal.email,
      labels: LABELS_RESPONSE.labels.map(({ id, name, type }) => ({ id, name, type })),
    },
  });
  expect(await row(id)).toMatchObject({ result: expect.any(String), outcome: "success" });
  expect((await callRows()).find((call) => call.tool === "list_labels")!.outcome).toBe("success");
});
it.each(["connection", "account"])(
  "stores only the outcome when %s ends during execution",
  async (by) => {
    const f = await fixture();
    await setting(f, "ask");
    const id = await ask(f);
    const d = await digest(f, id);
    const entered = deferred(),
      release = deferred();
    google.labelAnswers.push(async () => {
      entered.resolve();
      await release.promise;
      return Response.json(LABELS_RESPONSE);
    });
    const running = post(f, id, "approve", { digest: d });
    await entered.promise;
    await end(f, by);
    release.resolve();
    expect((await decided(await running)).state.kind).toBe("succeeded");
    expect(await row(id)).toMatchObject({ result: null, outcome: "success" });
    expect((await callRows())[0]!.outcome).toBe("success");
  },
);
it("stores encrypted results with a different purpose and never stores them in the audit log", async () => {
  const f = await fixture();
  await setting(f, "ask");
  const id = await ask(f);
  await approve(f, id);
  const stored = (await row(id))!;
  expect(stored.result).not.toContain("Receipts");
  expect(JSON.parse(await fixtureOpen(`${id}:result`, stored.result!))).toHaveProperty(
    "result.labels",
  );
  for (const context of [`${crypto.randomUUID()}:result`, `${id}:arguments`])
    await expect(fixtureOpen(context, stored.result!)).rejects.toThrow();
  const columns = (
    await env.DB.prepare("PRAGMA table_info(calls)").all<{ name: string }>()
  ).results.map((row) => row.name);
  expect(columns).toEqual([
    "id",
    "connection_id",
    "account_id",
    "tool",
    "at",
    "outcome",
    "also",
    "reason",
  ]);
  expect(JSON.stringify(await callRows())).not.toContain("Receipts");
});
it("returns failed as a non-error status with the normal tool error and audit outcome", async () => {
  const f = await fixture();
  await setting(f, "ask");
  const id = await ask(f);
  google.labelAnswers.push(() => new Response(null, { status: 503 }));
  const decided = await approve(f, id);
  const message = `Google could not complete the request for ${f.personal.email}. Try again later.`;
  expect(decided.state).toEqual({ kind: "failed", message });
  const answer = await get(f, id);
  expect(answer).toEqual({
    status: "failed",
    error: { code: "google_unavailable", message },
  });
  expect((await callRows())[0]).toMatchObject({
    outcome: "failed",
    reason: (answer.error as { code: string }).code,
  });
  expect((await callRows()).map((call) => call.outcome)).toEqual(["failed", "success"]);
  await setting(f, "deny");
  expect((await page(f, id)).state).toEqual({ kind: "failed", message: null });
  expect(await get(f, id)).toEqual({ status: "failed" });
});

it("uses the read statement to withhold results after one hour and when any used setting is absent", async () => {
  const f = await fixture();
  await setting(f, "ask");
  const id = await ask(f);
  await approve(f, id);
  expect(await get(f, id)).toHaveProperty("result");
  await env.DB.prepare("UPDATE approvals SET uses = ? WHERE id = ?")
    .bind(
      JSON.stringify([
        { account: f.personal.id, tool: "list_labels" },
        { account: f.northwind.id, tool: "list_labels" },
      ]),
      id,
    )
    .run();
  expect(await get(f, id)).toEqual({ status: "success" });
  await setting(f, "allow", f.northwind);
  expect(await get(f, id)).toHaveProperty("result");
  vi.spyOn(Date, "now").mockReturnValue(NOW + 3_600_000);
  await f.mcp.browser.authenticate();
  await f.mcp.keepTokens(await f.mcp.refresh());
  expect(await get(f, id)).toEqual({ status: "success" });
  expect((await row(id))!.result).not.toBeNull(); // SQL withholds even before the cleanup job.
});
it("checks every used account in the decision batch", async () => {
  const f = await fixture();
  await setting(f, "ask");
  const id = await ask(f);
  await env.DB.prepare("UPDATE approvals SET uses = ? WHERE id = ?")
    .bind(
      JSON.stringify([
        { account: f.personal.id, tool: "list_labels" },
        { account: f.northwind.id, tool: "list_labels" },
      ]),
      id,
    )
    .run();
  const ctx = await context();
  const stored = (await Effect.runPromise(readApproval(ctx, parseApprovalId(id)!, NOW)))!;
  const decide = () =>
    Effect.runPromise(
      decideApproval(ctx, {
        id: stored.id,
        at: NOW,
        action: "approve",
      }),
    );
  const denied = await decide();
  expect({ won: denied.won !== null, credentials: denied.credentials ?? [] }).toEqual({
    won: false,
    credentials: [],
  });
  expect(google.labelRequests).toEqual([]);
  await setting(f, "allow", f.northwind);
  const allowed = await decide();
  expect(allowed.won !== null).toBe(true);
  expect(allowed.credentials).toHaveLength(2);
});
it.each(["page", "get_approval"])(
  "persists expiry before answering from %s and refuses a later Approve",
  async (reader) => {
    const f = await fixture();
    await setting(f, "ask");
    const id = await ask(f);
    const d = await digest(f, id);
    await env.DB.prepare("UPDATE approvals SET expires_at = ? WHERE id = ?").bind(NOW, id).run();
    if (reader === "page") expect((await page(f, id)).state.kind).toBe("expired");
    else expect(await get(f, id)).toEqual({ status: "expired" });
    expect(await row(id)).toMatchObject({ state: "expired", arguments: null });
    expect((await callRows())[0]!.outcome).toBe("expired");
    expect((await decided(await post(f, id, "approve", { digest: d }))).state.kind).toBe("expired");
    expect(google.labelRequests).toEqual([]);
  },
);
it.each(["page", "get_approval"])(
  "persists unknown before answering from %s and ignores a late result",
  async (reader) => {
    const f = await fixture();
    await setting(f, "ask");
    const id = await ask(f);
    const d = await digest(f, id);
    const entered = deferred(),
      release = deferred();
    google.labelAnswers.push(async () => {
      entered.resolve();
      await release.promise;
      return Response.json(LABELS_RESPONSE);
    });
    const running = post(f, id, "approve", { digest: d });
    await entered.promise;
    vi.spyOn(Date, "now").mockReturnValue(NOW + 30_000);
    if (reader === "page") expect((await page(f, id)).state.kind).toBe("unknown");
    else expect(await get(f, id)).toEqual({ status: "unknown" });
    expect(await row(id)).toMatchObject({ outcome: "unknown" });
    // Restore time to prove the outcome guard checks the stored state, not only the clock.
    vi.spyOn(Date, "now").mockReturnValue(NOW + 1000);
    release.resolve();
    expect((await decided(await running)).state.kind).toBe("unknown");
    expect(await get(f, id)).toEqual({ status: "unknown" });
    expect((await callRows())[0]!.outcome).toBeNull();
  },
);
it("limits the outcome batch to thirty seconds even without a settling read", async () => {
  const f = await fixture();
  await setting(f, "ask");
  const id = await ask(f);
  const winningClaim = observeDecisions();
  // Keep the genuine Won even though the route cannot confirm the outcome write.
  const db = observeStatements(env.DB, (sql) => {
    if (sql.startsWith("UPDATE approvals SET outcome = ?5")) throw new Error("lost");
  });
  expect(
    (await post(f, id, "approve", { digest: await digest(f, id) }, testEnv({ DB: db }))).status,
  ).toBe(503);
  await Effect.runPromise(
    finishApproval(
      await context(),
      await winningClaim(id),
      NOW + 30_000,
      "success",
      "success",
      null,
      null,
    ),
  );
  expect(await row(id)).toMatchObject({ outcome: null });
  expect((await callRows())[0]!.outcome).toBeNull();
});
it.each(["mismatch", "resetting", "missing config"])(
  "does no scheduled writes while the deploy has %s and catches up afterwards",
  async (locked) => {
    const f = await fixture();
    await setting(f, "ask");
    const expired = await ask(f),
      completed = await ask(f);
    await approve(f, completed);
    vi.spyOn(Date, "now").mockReturnValue(NOW + 3_600_000);
    if (locked === "resetting")
      await setOwner({ state: "resetting", generation: 1, email: OWNER_EMAIL });
    const before = await dump();
    const writes: string[] = [];
    const db = observeStatements(env.DB, (sql) => {
      if (/^(UPDATE|DELETE|INSERT)/.test(sql)) writes.push(sql);
    });
    await scheduled(
      {} as ScheduledController,
      testEnv({
        DB: db,
        ...(locked === "mismatch"
          ? { OWNER_EMAIL: "changed@example.com" }
          : locked === "missing config"
            ? { TOKEN_KEY: undefined }
            : {}),
      }),
    );
    expect(writes).toEqual([]);
    expect(await dump()).toEqual(before);
    if (locked === "resetting")
      await setOwner({ state: "pinned", generation: 1, email: OWNER_EMAIL });
    await scheduled({} as ScheduledController, testEnv());
    expect(await row(expired)).toMatchObject({ state: "expired", arguments: null });
    expect(await row(completed)).toMatchObject({
      state: "approved",
      outcome: "success",
      result: null,
    });
    expect(await rows()).toHaveLength(2);
    expect((await callRows()).map((call) => call.outcome)).toEqual(["expired", "success"]);
  },
);
it("guards every scheduled statement when the owner changes after the preflight read", async () => {
  const f = await fixture();
  await setting(f, "ask");
  const id = await ask(f);
  await env.DB.prepare("UPDATE approvals SET expires_at = ? WHERE id = ?").bind(NOW, id).run();
  let changed = false;
  const db = observeStatements(env.DB, async (sql) => {
    if (!changed && sql.startsWith("UPDATE calls")) {
      changed = true;
      await setOwner({ state: "pinned", generation: 2, email: OWNER_EMAIL });
    }
  });
  await scheduled({} as ScheduledController, testEnv({ DB: db }));
  expect(changed).toBe(true);
  expect((await row(id))!.state).toBe("waiting");
  expect((await callRows())[0]!.outcome).toBe("pending");
});
it("reset deletes all approvals and late work cannot change the new owner's rows", async () => {
  const f = await fixture();
  await setting(f, "ask");
  const id = await ask(f);
  const d = await digest(f, id);
  const old = await context();
  const entered = deferred(),
    release = deferred();
  google.labelAnswers.push(async () => {
    entered.resolve();
    await release.promise;
    return Response.json(LABELS_RESPONSE);
  });
  const running = post(f, id, "approve", { digest: d });
  await entered.promise;
  await resetOwner();
  expect(await rows()).toEqual([]);
  const next = await new McpClient().connect("New owner connection");
  await toolCall(next, "list_accounts");
  const newCall = (await callRows())[0]!;
  await env.DB.prepare(
    "INSERT INTO approvals (id,generation,connection_id,call_id,tool,uses,created_at,expires_at,state,decided_at) VALUES (?,2,?,?,'list_labels','[]',?,?,'approved',?)",
  )
    .bind(id, newCall.connection_id, newCall.id, NOW, NOW + 3_600_000, NOW)
    .run();
  const before = await dump();
  release.resolve();
  expect((await running).status).toBe(404);
  await Effect.runPromise(cleanupApprovals(old, NOW + 4_000_000));
  await Effect.runPromise(readApproval(old, parseApprovalId(id)!, NOW + 4_000_000));
  expect(await dump()).toEqual(before);
});
it("audits missing and non-string get_approval inputs as the same refusal", async () => {
  const f = await fixture();
  const texts = new Set<string>();
  for (const args of [undefined, {}, { approval: null }, { approval: [] }, { approval: 3 }])
    texts.add(
      await expectError(await toolCall(f.mcp, "get_approval", args), "approval_not_available", /./),
    );
  expect(texts.size).toBe(1);
  expect((await callRows()).map((row) => row.outcome)).toEqual(Array(5).fill("refused"));
});

it("stores no result when the connection expires during an approved run without an owner change", async () => {
  const f = await fixture();
  await setting(f, "ask");
  const id = await ask(f);
  const d = await digest(f, id);
  const entered = deferred(),
    release = deferred();
  google.labelAnswers.push(async () => {
    entered.resolve();
    await release.promise;
    return Response.json(LABELS_RESPONSE);
  });
  const running = post(f, id, "approve", { digest: d });
  await entered.promise;
  await env.DB.prepare("UPDATE connections SET expires_at = ? WHERE id = ?")
    .bind(NOW - 1, f.connection.id)
    .run();
  release.resolve();
  expect((await decided(await running)).state.kind).toBe("succeeded");
  expect(await row(id)).toMatchObject({ outcome: "success", result: null });
  expect((await callRows())[0]!.outcome).toBe("success");
  expect((await toolCall(f.mcp, "get_approval", { approval: id })).status).toBe(401);
  // Even if the connection becomes usable again, the result was never retained.
  await env.DB.prepare("UPDATE connections SET expires_at = ? WHERE id = ?")
    .bind(NOW + 3_600_000, f.connection.id)
    .run();
  expect(await get(f, id)).toEqual({ status: "success" });
});

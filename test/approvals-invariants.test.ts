import { env } from "cloudflare:workers";
import { createScheduledController } from "cloudflare:test";
import { Effect } from "effect";
import { expect, it, vi } from "vite-plus/test";
import "./support/account-checks";
import worker from "../src/index";
import {
  cleanupApprovals,
  decideApproval,
  finishApproval,
  readApproval,
} from "../src/approvals/store";
import { RUN_DEADLINE, OUTCOME_WINDOW, parseApprovalId } from "../src/approvals/model";
import { readOwner } from "../src/owner/owner";
import { seal } from "../src/seal";
import { readConfig } from "../src/config";
import { Result } from "effect";
import { NOW } from "./support/accounts";
import { fixture, callRows, toolCall, PERSONAL, expectError } from "./support/permissions";
import { ask, page, post, get, row, setting } from "./support/approvals";
import { testEnv } from "./support/worker";
import { McpClient, rpcResult } from "./support/oauth";
import { google } from "./support/google";

const context = async () => {
  const owner = await Effect.runPromise(readOwner(env.DB));
  return { db: env.DB, owner: { generation: owner.generation, email: owner.email! } };
};
const claim = async (id: string) => {
  const ctx = await context();
  const result = await Effect.runPromise(
    decideApproval(ctx, { id: parseApprovalId(id)!, at: NOW, action: "approve" }),
  );
  expect(result.won !== null).toBe(true);
  if (!result.won) throw new Error("Expected a winning decision");
  return result.won;
};

it("expires waiting approvals through the Worker's scheduled export", async () => {
  const f = await fixture();
  await setting(f, "ask");
  const id = await ask(f);
  vi.spyOn(Date, "now").mockReturnValue(NOW + 3_600_000);
  expect(worker).toHaveProperty("scheduled", expect.any(Function));
  await worker.scheduled(
    createScheduledController({ scheduledTime: NOW + 3_600_000, cron: "*/10 * * * *" }),
    testEnv(),
  );
  expect(await row(id)).toMatchObject({ state: "expired", arguments: null });
  expect((await callRows())[0]!.outcome).toBe("expired");
});

it("settles abandoned approved calls in scheduled cleanup, only at thirty seconds and for the pinned owner", async () => {
  const f = await fixture();
  await setting(f, "ask");
  const id = await ask(f);
  await claim(id);
  const ctx = await context();
  await Effect.runPromise(cleanupApprovals(ctx, NOW + 29_999));
  expect((await row(id))!.outcome).toBeNull();
  await Effect.runPromise(
    cleanupApprovals(
      {
        ...ctx,
        owner: {
          ...ctx.owner,
          generation: (ctx.owner.generation + 1) as typeof ctx.owner.generation,
        },
      },
      NOW + 30_000,
    ),
  );
  expect((await row(id))!.outcome).toBeNull();
  await Effect.runPromise(cleanupApprovals(ctx, NOW + 30_000));
  expect((await row(id))!.outcome).toBe("unknown");
  expect((await callRows())[0]!.outcome).toBeNull();
});

it("keeps a running approval unsettled until exactly thirty seconds in the read", async () => {
  const f = await fixture();
  await setting(f, "ask");
  const id = await ask(f);
  await claim(id);
  vi.spyOn(Date, "now").mockReturnValue(NOW + 29_999);
  expect(await get(f, id)).toMatchObject({ status: "running" });
  expect((await row(id))!.outcome).toBeNull();
  vi.spyOn(Date, "now").mockReturnValue(NOW + 30_000);
  expect(await get(f, id)).toEqual({ status: "unknown" });
  expect((await row(id))!.outcome).toBe("unknown");
});

it.each(["tool", "connection", "account"])(
  "purges only approvals affected by the owner's %s change",
  async (by) => {
    const f = await fixture();
    const otherMcp = await new McpClient().connect("Other connection");
    const other = { ...f, mcp: otherMcp, connection: { ...f.connection } };
    // Resolve the connection ID from D1, rather than relying on client internals.
    other.connection.id = (await env.DB.prepare(
      "SELECT id FROM connections WHERE name = 'Other connection'",
    ).first<{ id: typeof f.connection.id }>())!.id;
    const approvals: { id: string; connection: string; account: string }[] = [];
    for (const client of [f, other])
      for (const account of [f.personal, f.northwind]) {
        await setting(client, "ask", account);
        approvals.push({
          id: await ask(client, { account: account.email }),
          connection: client.connection.id,
          account: account.id,
        });
      }
    if (by === "tool") await setting(f, "deny");
    else
      expect(
        (
          await f.mcp.browser.post(
            by === "connection"
              ? `/connections/${f.connection.id}/revoke`
              : `/accounts/${f.personal.id}/remove`,
          )
        ).status,
      ).toBe(200);
    const audit = await callRows();
    for (const entry of approvals) {
      const affected =
        by === "tool"
          ? entry.connection === f.connection.id && entry.account === f.personal.id
          : by === "connection"
            ? entry.connection === f.connection.id
            : entry.account === f.personal.id;
      const stored = (await row(entry.id))!;
      expect(stored).toMatchObject({
        state: affected ? "refused" : "waiting",
      });
      expect(audit.find((call) => call.id === stored.call_id)!.outcome).toBe(
        affected ? "refused" : "pending",
      );
    }
  },
);

it("does not let a different claim or decision time finish the winner's call", async () => {
  const f = await fixture();
  await setting(f, "ask");
  const id = await ask(f);
  const winner = await claim(id);
  const ctx = await context();
  for (const impostor of [
    { ...winner, claim: crypto.randomUUID() },
    { ...winner, at: NOW + 1 },
  ]) {
    await Effect.runPromise(finishApproval(ctx, impostor, NOW + 1000, "unknown", null, null));
    expect((await row(id))!.outcome).toBeNull();
  }
});

it.each(["settle", "decide", "finish", "purge", "cron"])(
  "matches both audit identifiers during %s",
  async (operation) => {
    const f = await fixture();
    await setting(f, "ask");
    const id = await ask(f);
    const ctx = await context();
    const winner = operation === "finish" ? await claim(id) : null;
    const stored = (await row(id))!;
    const other = await new McpClient().connect("Other audit owner");
    await rpcResult(await toolCall(other, "list_accounts"));
    const foreign = (await callRows()).find((call) => call.connection_id !== stored.connection_id)!;
    await env.DB.prepare("UPDATE calls SET outcome = ? WHERE id = ?")
      .bind(operation === "finish" ? null : "pending", foreign.id)
      .run();
    await env.DB.prepare("UPDATE approvals SET call_id = ? WHERE id = ?")
      .bind(foreign.id, id)
      .run();
    if (operation === "settle" || operation === "cron") {
      await env.DB.prepare("UPDATE approvals SET expires_at = ? WHERE id = ?").bind(NOW, id).run();
      if (operation === "settle") await page(f, id);
      else await Effect.runPromise(cleanupApprovals(ctx, NOW));
    } else if (operation === "decide") await post(f, id, "reject");
    else if (operation === "purge") await setting(f, "deny");
    else if (winner)
      await Effect.runPromise(finishApproval(ctx, winner, NOW, "success", "success", null));
    expect((await callRows()).find((call) => call.id === stored.call_id)!.outcome).toBe(
      operation === "finish" ? null : "pending",
    );
    expect((await callRows()).find((call) => call.id === foreign.id)!.outcome).toBe(
      operation === "finish" ? null : "pending",
    );
  },
);

it("refuses to show or approve stored arguments that no longer match the tool schema", async () => {
  const f = await fixture();
  await setting(f, "ask");
  const id = await ask(f);
  const config = readConfig(testEnv());
  if (Result.isFailure(config)) throw new Error("Invalid config");
  const encrypted = await seal(
    config.success.tokenKey,
    `${id}:arguments`,
    JSON.stringify({ account: 42 }),
  );
  await env.DB.prepare("UPDATE approvals SET arguments = ? WHERE id = ?").bind(encrypted, id).run();
  expect((await page(f, id)).state).toMatchObject({ kind: "waiting", shown: false, digest: null });
  expect((await post(f, id, "approve", { digest: "anything" })).status).toBe(200);
  expect((await row(id))!.state).toBe("waiting");
  expect(google.labelRequests).toEqual([]);
});

it("refuses a multi-account view and Approve while keeping Reject available", async () => {
  const f = await fixture();
  await setting(f, "ask");
  await setting(f, "ask", f.northwind);
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
  expect((await page(f, id)).state).toMatchObject({ kind: "waiting", shown: false, digest: null });
  const html = await (await f.mcp.browser.get(`/approvals/${id}`)).text();
  expect(html).not.toContain(">Approve</button>");
  expect(html).toContain(">Reject</button>");
  await post(f, id, "approve");
  expect((await row(id))!.state).toBe("waiting");
  expect(google.labelRequests).toEqual([]);
});

it("explains oversized arguments without misreporting their schema", async () => {
  const f = await fixture();
  await setting(f, "ask");
  await expectError(
    await toolCall(f.mcp, "list_labels", { account: "x".repeat(256 * 1024) + PERSONAL }),
    "invalid_arguments",
    /^The arguments are too large\. The limit is 256 KB\.$/,
  );
});

it("requires a decision-issued Won to finish an approval at compile time", async () => {
  const ctx = await context();
  const handBuilt = {
    id: parseApprovalId(crypto.randomUUID())!,
    at: NOW,
    claim: crypto.randomUUID(),
  };
  // @ts-expect-error Only decideApproval can issue the private Won brand.
  const write = finishApproval(ctx, handBuilt, NOW, "success", "success", null);
  expect(Effect.isEffect(write)).toBe(true);
});
it("keeps the run deadline inside the outcome window", () => {
  expect(RUN_DEADLINE).toBeLessThan(OUTCOME_WINDOW);
});

it("fails closed when an approval row cannot be decoded", async () => {
  const f = await fixture();
  await setting(f, "ask");
  const id = await ask(f);
  await env.DB.prepare("UPDATE approvals SET tool = 'not_a_tool' WHERE id = ?").bind(id).run();
  const read = await Effect.runPromise(
    Effect.result(readApproval(await context(), parseApprovalId(id)!, NOW)),
  );
  expect(Result.isFailure(read) && read.failure._tag).toBe("WriteUncertain");
  expect((await f.mcp.browser.get(`/approvals/${id}`)).status).toBe(503);
  await expectError(
    await toolCall(f.mcp, "get_approval", { approval: id }),
    "server_unavailable",
    /^The server could not complete the call\. Try again later\.$/,
  );
  expect(google.labelRequests).toEqual([]);
});

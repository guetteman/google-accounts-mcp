import { env } from "cloudflare:workers";
import { Effect } from "effect";
import { expect, it } from "vite-plus/test";
import "./support/account-checks";
import {
  cleanupApprovals,
  decideApproval,
  finishApproval,
  purgeApprovals,
} from "../src/approvals/store";
import { parseApprovalId, type SnapshotAccount } from "../src/approvals/model";
import { readOwner } from "../src/owner/owner";
import { NOW } from "./support/accounts";
import { observeStatements } from "./support/db";
import { fixture } from "./support/permissions";
import { ask, approve, page, post, setting } from "./support/approvals";
import { testEnv } from "./support/worker";

const context = async (db = env.DB) => {
  const owner = await Effect.runPromise(readOwner(env.DB));
  return { db, owner: { generation: owner.generation, email: owner.email! } };
};

it("looks up calls by primary key in every approval audit statement", async () => {
  const f = await fixture();
  await setting(f, "ask");
  let operation = "create";
  const plans: { operation: string; details: string[] }[] = [];
  const db = observeStatements(env.DB, async (sql) => {
    if (!/^UPDATE calls\b/.test(sql) || !sql.includes("approvals")) return;
    const parameters = Math.max(...Array.from(sql.matchAll(/\?(\d+)/g), (m) => Number(m[1])));
    const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .bind(...Array(parameters).fill(null))
      .all<{ detail: string }>();
    plans.push({ operation, details: plan.results.map((row) => row.detail) });
  });
  const workerEnv = testEnv({ DB: db });
  const id = await ask(f, undefined, workerEnv);
  operation = "settle";
  await page(f, id, workerEnv);
  operation = "decide";
  await approve(f, id, workerEnv);
  operation = "finish";
  await Effect.runPromise(
    finishApproval(await context(db), parseApprovalId(id)!, NOW, "success", "success", null, false),
  );
  const rejected = await ask(f);
  operation = "reject";
  expect((await post(f, rejected, "reject", {}, workerEnv)).status).toBe(200);
  for (const by of ["tool", "account", "connection"]) {
    operation = `purge ${by}`;
    const path =
      by === "tool"
        ? `/connections/${f.connection.id}/permissions`
        : by === "account"
          ? `/accounts/${f.personal.id}/remove`
          : `/connections/${f.connection.id}/revoke`;
    const response = await f.mcp.browser.post(
      path,
      by === "tool" ? { account: f.personal.id, tool: "list_labels", setting: "deny" } : {},
      { env: workerEnv },
    );
    expect(await response.json()).toEqual({ outcome: "ok" });
  }
  operation = "cron";
  await Effect.runPromise(cleanupApprovals(await context(db), NOW + 3_600_000));
  expect(new Set(plans.map((p) => p.operation))).toEqual(
    new Set([
      "create",
      "settle",
      "decide",
      "finish",
      "reject",
      "purge tool",
      "purge account",
      "purge connection",
      "cron",
    ]),
  );
  for (const plan of plans) {
    expect(plan.details.join("\n"), plan.operation).not.toMatch(/SCAN calls\b/);
    expect(plan.details.join("\n"), plan.operation).toMatch(
      /SEARCH calls USING INTEGER PRIMARY KEY/,
    );
  }
});

it("changes no rows when scheduled cleanup runs again after cleaning everything", async () => {
  const f = await fixture();
  await setting(f, "ask");
  const completed = await ask(f);
  await approve(f, completed);
  await ask(f);
  const ctx = await context();
  const first = await Effect.runPromise(cleanupApprovals(ctx, NOW + 3_600_000));
  expect(first.map((result) => result.meta.changes)).toEqual([1, 1, 1]);
  const second = await Effect.runPromise(cleanupApprovals(ctx, NOW + 3_600_000));
  expect(second.map((result) => result.meta.changes)).toEqual([0, 0, 0]);
  const index = await env.DB.prepare(
    "SELECT sql FROM sqlite_master WHERE name = 'approvals_results'",
  ).first<{ sql: string }>();
  expect(index?.sql).toMatch(/ON approvals\(decided_at\) WHERE result IS NOT NULL/);
});

it("does not rewrite already purged approvals", async () => {
  const f = await fixture();
  await setting(f, "ask");
  await ask(f);
  const ctx = await context();
  const purge = () =>
    env.DB.batch(
      purgeApprovals(env.DB, {
        where: "approvals.connection_id = ?1",
        guard:
          "EXISTS (SELECT 1 FROM connections c WHERE c.id = approvals.connection_id AND c.expires_at > ?4)",
        generation: "?2",
        email: "?3",
        now: "?4",
        by: "tool",
        values: [f.connection.id, ctx.owner.generation, ctx.owner.email, NOW],
      }),
    );
  expect((await purge()).map((result) => result.meta.changes)).toEqual([0, 0, 1, 1, 1]);
  expect((await purge()).map((result) => result.meta.changes)).toEqual([0, 0, 0, 0, 0]);
});

it("reads only the credential and account-view columns for the winning decision", async () => {
  const f = await fixture();
  await setting(f, "ask");
  const id = parseApprovalId(await ask(f))!;
  const account = await env.DB.prepare(
    "SELECT id, name, email, hd, version FROM accounts WHERE id = ?",
  )
    .bind(f.personal.id)
    .first<SnapshotAccount>();
  const name = await env.DB.prepare("SELECT name FROM connections WHERE id = ?")
    .bind(f.connection.id)
    .first<string>("name");
  const decision = await Effect.runPromise(
    decideApproval(await context(), {
      id,
      at: NOW,
      claim: crypto.randomUUID(),
      action: "approve",
      snapshot: { connection: name!, accounts: [account!] },
    }),
  );
  expect(decision.won).toBe(true);
  expect(decision.credentials).toHaveLength(1);
  expect(Object.keys(decision.credentials[0]!).sort()).toEqual(
    [
      "id",
      "name",
      "email",
      "hd",
      "health",
      "scopes",
      "refresh_key",
      "access_key",
      "version",
      "blocked_until",
      "refresh_token",
      "access_token",
      "access_expires_at",
    ].sort(),
  );
});

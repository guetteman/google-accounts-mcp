import { env } from "cloudflare:workers";
import { Effect } from "effect";
import { expect, it } from "vite-plus/test";
import "./support/account-checks";
import { cleanupApprovals, finishApproval, endApprovals } from "../src/approvals/store";
import { parseConnectionId } from "../src/connections/model";
import { readOwner } from "../src/owner/owner";
import { NOW } from "./support/accounts";
import { observeStatements } from "./support/db";
import { fixture } from "./support/permissions";
import { ask, approve, page, post, setting, observeDecisions } from "./support/approvals";
import { testEnv } from "./support/worker";

const context = async (db = env.DB) => {
  const owner = await Effect.runPromise(readOwner(env.DB));
  return { db, owner: { generation: owner.generation, email: owner.email! } };
};
// D1 bills every changed row, so a run with nothing left to clean must change none.
const changes = (results: readonly D1Result[]) =>
  results.reduce((sum, result) => sum + result.meta.changes, 0);

it("looks up calls by record ID in every approval audit statement", async () => {
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
  const winningClaim = observeDecisions();
  operation = "decide";
  await approve(f, id, workerEnv);
  operation = "finish";
  await Effect.runPromise(
    finishApproval(
      await context(db),
      await winningClaim(id),
      NOW,
      "success",
      "success",
      null,
      null,
    ),
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
    // Activity's outcome index can also seek a record by rowid. The lookup must include
    // equality on that ID; selecting every pending call would grow with the log.
    expect(plan.details.join("\n"), plan.operation).toMatch(
      /SEARCH calls USING (?:INTEGER PRIMARY KEY|(?:COVERING )?INDEX \S+) \([^\n)]*\browid=\?/,
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
  expect(changes(first)).toBeGreaterThan(0);
  const second = await Effect.runPromise(cleanupApprovals(ctx, NOW + 3_600_000));
  expect(changes(second)).toBe(0);
});

it("deletes stored text once and does not rewrite clean approvals", async () => {
  const f = await fixture();
  await setting(f, "ask");
  const completed = await ask(f);
  await approve(f, completed);
  await ask(f);
  const ctx = await context();
  const purge = () =>
    env.DB.batch(
      endApprovals(env.DB, ctx.owner, { connection: parseConnectionId(f.connection.id)! }, NOW),
    );
  expect(changes(await purge())).toBeGreaterThan(0);
  expect(changes(await purge())).toBe(0);
});

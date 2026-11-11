import { env } from "cloudflare:workers";
import { resetPlan } from "../src/owner/reset";
import { expect, it } from "vite-plus/test";
import "./support/account-checks";
import { NOW } from "./support/accounts";
import { observeStatements, ownerInstance, ownerRow, statementFailingDb } from "./support/db";
import { google } from "./support/google";
import {
  callRows,
  expectError,
  fixture,
  googleTraffic,
  permission,
  permissionRows,
  PERSONAL,
  SERVER_MESSAGE,
  toolCall,
} from "./support/permissions";
import { testEnv } from "./support/worker";

it("records a failed call when D1 cannot persist the refreshed Google token", async () => {
  const f = await fixture({ access_expires_at: NOW });
  await permission(f);
  const before = googleTraffic().length;
  const db = statementFailingDb(/UPDATE accounts AS a SET access_token =/);
  await expectError(
    await toolCall(f.mcp, "list_labels", { account: PERSONAL }, testEnv({ DB: db })),
    "server_unavailable",
    SERVER_MESSAGE,
  );
  expect(googleTraffic().slice(before)).toEqual(["https://oauth2.googleapis.com/token"]);
  expect(google.labelRequests).toEqual([]);
  expect(await callRows()).toEqual([
    expect.objectContaining({
      connection_id: f.connection.id,
      account_id: f.personal.id,
      tool: "list_labels",
      outcome: "failed",
    }),
  ]);
});

it("writes no call record when the credential read in its batch fails", async () => {
  const f = await fixture();
  await permission(f);
  const before = googleTraffic().length;
  const db = statementFailingDb(/SELECT a\.id, a\.name[\s\S]*a\.refresh_token, a\.access_token/);
  await expectError(
    await toolCall(f.mcp, "list_labels", { account: PERSONAL }, testEnv({ DB: db })),
    "server_unavailable",
    SERVER_MESSAGE,
  );
  expect(await callRows()).toEqual([]);
  expect(googleTraffic().slice(before)).toEqual([]);
});

async function beginReset() {
  const row = await ownerRow();
  expect(row).not.toBeNull();
  const plan = resetPlan({ ...row!, instance: await ownerInstance() }, NOW);
  await env.DB.prepare(plan.statements[0]!).run();
  expect((await ownerRow())?.state).toBe("resetting");
}

it.each(["list_accounts", "list_labels"])(
  "records nothing for %s if owner reset starts after authentication",
  async (name) => {
    const f = await fixture();
    await permission(f);
    let resetStarted = false;
    const db = observeStatements(env.DB, async (sql) => {
      if (!resetStarted && /INSERT INTO calls/.test(sql)) {
        await beginReset();
        resetStarted = true;
      }
    });
    const before = googleTraffic().length;
    await expectError(
      await toolCall(f.mcp, name, { account: PERSONAL }, testEnv({ DB: db })),
      "server_unavailable",
      SERVER_MESSAGE,
    );
    expect(resetStarted).toBe(true);
    expect(await callRows()).toEqual([]);
    expect(googleTraffic().slice(before)).toEqual([]);
  },
);

it.each([true, false])(
  "does not change a permission to allowed=%s if reset starts after owner authentication",
  async (allowed) => {
    const f = await fixture();
    if (!allowed) await permission(f);
    const before = await permissionRows();
    let resetStarted = false;
    const db = observeStatements(env.DB, async (sql) => {
      if (!resetStarted && /(?:INSERT INTO|DELETE FROM) permissions/.test(sql)) {
        await beginReset();
        resetStarted = true;
      }
    });
    const response = await f.mcp.browser.post(
      `/connections/${f.connection.id}/permissions`,
      { account: f.personal.id, tool: "list_labels", setting: allowed ? "allow" : "deny" },
      { env: testEnv({ DB: db }) },
    );
    expect(await response.json()).toEqual({ outcome: "not_found" });
    expect(resetStarted).toBe(true);
    expect(await permissionRows()).toEqual(before);
  },
);

it("records a failed list_accounts call when its account query fails after recording", async () => {
  const f = await fixture();
  await permission(f);
  const before = googleTraffic().length;
  const db = statementFailingDb(/SELECT a\.id, a\.name/);
  await expectError(
    await toolCall(f.mcp, "list_accounts", undefined, testEnv({ DB: db })),
    "server_unavailable",
    SERVER_MESSAGE,
  );
  expect(await callRows()).toEqual([
    expect.objectContaining({
      connection_id: f.connection.id,
      account_id: null,
      tool: "list_accounts",
      outcome: "failed",
    }),
  ]);
  expect(googleTraffic().slice(before)).toEqual([]);
});

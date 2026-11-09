import { env } from "cloudflare:workers";
import { expect, it, vi } from "vite-plus/test";
import "./support/account-checks";
import { accounts, finish, ownerBrowser, seedAccount, start } from "./support/accounts";
import { google } from "./support/google";
import { brokenDb, dump, observeStatements, statementFailingDb } from "./support/db";
import { testEnv, textOf } from "./support/worker";

it.each(["unknown", "removed", "earlier generation"])(
  "refuses reconnect and removal of an %s account without contacting Google",
  async (kind) => {
    const row = await seedAccount(
      kind === "removed"
        ? { state: "removed", refresh_token: null, access_token: null, removed_at: 1 }
        : kind === "earlier generation"
          ? { generation: 0 }
          : {},
    );
    const id = kind === "unknown" ? crypto.randomUUID() : row.id;
    const b = await ownerBrowser();
    const before = await dump();
    for (const action of ["reconnect", "remove"]) {
      const response = await b.post(`/accounts/${id}/${action}`, { disconnect: "1" });
      expect(await response.json()).toEqual({ outcome: "not_found" });
      expect(response.headers.getSetCookie()).toEqual([]);
    }
    expect(google.events).toEqual([]);
    expect(await dump()).toEqual(before);
  },
);
it.each(["unchecked", "confirmed", "failed", "timeout", "no token", "damaged token"])(
  "removes access with disconnect %s and never revokes after the removal write",
  async (kind) => {
    const row = await seedAccount(
      kind === "no token"
        ? { health: "needs_reconnect", refresh_token: null, access_token: null }
        : kind === "damaged token"
          ? { refresh_token: "damaged" }
          : {},
    );
    const b = await ownerBrowser();
    const db = observeStatements(env.DB, (sql) => {
      if (/UPDATE accounts/i.test(sql)) google.events.push("write");
    });
    if (kind === "failed") google.revokeAnswer = 503;
    if (kind === "timeout") {
      google.revokeAnswer = "slow";
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    }
    const pending = b.post(
      `/accounts/${row.id}/remove`,
      kind === "unchecked" ? {} : { disconnect: "1" },
      { env: testEnv({ DB: db }) },
    );
    if (kind === "timeout") {
      await vi.waitFor(() => expect(google.pending).toHaveLength(1));
      await vi.advanceTimersByTimeAsync(10001);
    }
    expect(await (await pending).json()).toEqual({ outcome: "ok" });
    expect((await accounts())[0]).toMatchObject({
      state: "removed",
      refresh_token: null,
      access_token: null,
    });
    expect(google.events).toEqual([
      ...(["confirmed", "failed", "timeout"].includes(kind) ? ["revoke"] : []),
      "write",
    ]);
    const alert =
      `Removed ${row.email}.` +
      (["failed", "timeout", "no token", "damaged token"].includes(kind)
        ? " Google didn't confirm the disconnect."
        : "");
    expect(textOf(await (await b.get("/accounts")).text())).toContain(alert);
    const html = textOf(await (await b.get("/accounts")).text());
    expect(html).toContain("No Google accounts yet");
  },
);
it("assigns a new ID when a removed Google account is connected again", async () => {
  const old = await seedAccount({ sub: "personal" });
  const b = await ownerBrowser();
  expect(await (await b.post(`/accounts/${old.id}/remove`)).json()).toEqual({ outcome: "ok" });
  await finish(b, (await start(b)).url);
  const rows = await accounts();
  expect(rows).toHaveLength(2);
  expect(rows.find((r) => r.id === old.id)).toMatchObject({
    state: "removed",
    email: old.email,
    name: old.name,
  });
  expect(rows.find((r) => r.state === "live")!.id).not.toBe(old.id);
});
it("renames only the trimmed display name and accepts one hundred Unicode code points", async () => {
  const row = await seedAccount();
  const b = await ownerBrowser();
  for (const name of ["Work", "😀".repeat(100)]) {
    const before = await dump();
    expect(
      await (await b.post(`/accounts/${row.id}/name`, { name: `  ${name}  ` })).json(),
    ).toEqual({ outcome: "ok" });
    const expected = structuredClone(before);
    (expected.accounts![0] as Record<string, unknown>).name = name;
    expect(await dump()).toEqual(expected);
  }
});
it.each([" ", "a".repeat(101), "😀".repeat(101)])(
  "rejects an invalid account name %s without changing any data",
  async (name) => {
    const row = await seedAccount();
    const b = await ownerBrowser();
    const before = await dump();
    expect(await (await b.post(`/accounts/${row.id}/name`, { name })).json()).toEqual({
      outcome: "invalid",
    });
    expect(await dump()).toEqual(before);
  },
);
it.each(["name", "remove", "connect", "reconnect"])(
  "distinguishes a database gate refusal from uncertainty while starting %s",
  async (action) => {
    const row = await seedAccount();
    const b = await ownerBrowser();
    const path = action === "connect" ? "/accounts/connect" : `/accounts/${row.id}/${action}`;
    const before = await dump();
    const gate = await b.post(path, { name: "Work" }, { env: testEnv({ DB: brokenDb() }) });
    expect(gate.status).toBe(503);
    expect(gate.headers.get("Content-Type")).toContain("text/html");
    expect(await dump()).toEqual(before);
    if (action !== "connect") {
      const failed = await b.post(
        path,
        { name: "Work" },
        { env: testEnv({ DB: statementFailingDb(/accounts/) }) },
      );
      expect(await failed.json()).toEqual({
        outcome: action === "reconnect" || action === "remove" ? "unavailable" : "unknown",
      });
      expect(await dump()).toEqual(before);
    }
  },
);
it.each(["name", "remove"])(
  "reports an uncertain %s write even when D1 committed it",
  async (action) => {
    const row = await seedAccount();
    const b = await ownerBrowser();
    const db = observeStatements(
      env.DB,
      () => {},
      (sql) => {
        if (/UPDATE accounts/i.test(sql)) throw new Error("response lost");
      },
    );
    const r = await b.post(
      `/accounts/${row.id}/${action}`,
      { name: "Work" },
      { env: testEnv({ DB: db }) },
    );
    expect(await r.json()).toEqual({ outcome: "unknown" });
    expect((await accounts())[0]).toMatchObject(
      action === "name"
        ? { name: "Work" }
        : { state: "removed", refresh_token: null, access_token: null },
    );
  },
);

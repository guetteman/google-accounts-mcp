import { env } from "cloudflare:workers";
import { expect, it, vi } from "vite-plus/test";
import "./support/account-checks";
import {
  accounts,
  call,
  credential,
  finish,
  fixtureOpen,
  NOW,
  ownerBrowser,
  seedAccount,
  start,
} from "./support/accounts";
import { deferred, google, MARKER, SCOPES } from "./support/google";
import { dump, observeStatements, statementFailingDb } from "./support/db";
import { resetOwner } from "./support/connections";
import { textOf } from "./support/worker";

it("erases revoked tokens and refuses later calls even when the old access token was fresh", async () => {
  const row = await seedAccount();
  google.gmailAnswers = [401];
  google.refreshAnswers = ["invalid_grant"];
  expect(await call(row.id)).toMatchObject({
    error: "NeedsReconnect",
    detail: { email: row.email },
  });
  expect((await accounts())[0]).toMatchObject({
    health: "needs_reconnect",
    refresh_token: null,
    access_token: null,
  });
  const before = [...google.events];
  expect(await call(row.id)).toMatchObject({ error: "NeedsReconnect" });
  expect(google.events).toEqual(before);
});
it("keeps the refresh token under an admin block and clears the block after ten minutes", async () => {
  const row = await seedAccount({ access_expires_at: NOW });
  google.refreshAnswers = ["admin_policy_enforced", "ok"];
  expect(await call(row.id)).toMatchObject({ error: "BlockedByAdmin" });
  expect((await accounts())[0]).toMatchObject({
    health: "blocked_by_admin",
    refresh_token: row.refresh_token,
  });
  expect(await call(row.id)).toMatchObject({ error: "BlockedByAdmin" });
  expect(google.events).toEqual(["refresh"]);
  vi.spyOn(Date, "now").mockReturnValue(NOW + 600001);
  expect(await call(row.id)).toMatchObject({ status: 200 });
  expect((await accounts())[0]).toMatchObject({ health: "ready", blocked_until: null });
});
it("lets only one caller claim an expired admin block and keeps its window after a timeout", async () => {
  const row = await seedAccount({
    health: "blocked_by_admin",
    blocked_until: NOW - 1,
    access_token: null,
    access_expires_at: null,
  });
  const snapshot = await credential(row.id);
  const entered = deferred(),
    release = deferred();
  let paused = false;
  const db = observeStatements(env.DB, async (sql) => {
    if (!paused && /UPDATE accounts/i.test(sql)) {
      paused = true;
      entered.resolve();
      await release.promise;
    }
  });
  google.refreshAnswers = ["slow"];
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const first = call(row.id, db, snapshot);
  const stage = await Promise.race([
    entered.promise.then(() => "paused"),
    first.then(() => "finished"),
  ]);
  expect(stage).toBe("paused");
  const second = call(row.id, env.DB, snapshot);
  await vi.waitFor(() => expect(google.pending).toHaveLength(1));
  release.resolve();
  expect(await first).toMatchObject({ error: "BlockedByAdmin" });
  await vi.advanceTimersByTimeAsync(10001);
  expect(await second).toMatchObject({ error: "GoogleUnavailable" });
  expect(await call(row.id)).toMatchObject({ error: "BlockedByAdmin" });
  expect(google.events).toEqual(["refresh"]);
  vi.spyOn(Date, "now").mockReturnValue(NOW + 600001);
  expect(await call(row.id)).toMatchObject({ status: 200 });
});
it.each([503, 429, "slow"] as const)(
  "keeps both ciphertexts and health unchanged when refresh answers %s",
  async (answer) => {
    const row = await seedAccount({ access_expires_at: NOW });
    const before = await dump();
    google.refreshAnswers = [answer];
    if (answer === "slow") vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pending = call(row.id);
    if (answer === "slow") {
      await vi.waitFor(() => expect(google.pending).toHaveLength(1));
      await vi.advanceTimersByTimeAsync(10001);
    }
    expect(await pending).toMatchObject({ error: "GoogleUnavailable" });
    expect(await dump()).toEqual(before);
    expect(google.events).toEqual(["refresh"]);
  },
);
it.each([301000, 299000, 300000])(
  "uses or refreshes an access token with %s milliseconds left",
  async (left) => {
    const row = await seedAccount({ access_expires_at: NOW + left });
    expect(await call(row.id)).toMatchObject({ status: 200 });
    expect(google.events).toEqual(left > 300000 ? ["gmail"] : ["refresh", "gmail"]);
    const stored = (await accounts())[0]!;
    expect(await fixtureOpen(`${row.id}:access`, stored.access_token!)).toBe(
      left > 300000
        ? await fixtureOpen(`${row.id}:access`, row.access_token!)
        : google.issuedAccess[0],
    );
  },
);
it("allows two simultaneous refreshes to persist and send their own requests", async () => {
  const row = await seedAccount({ access_expires_at: NOW });
  const snapshot = await credential(row.id);
  const entered = deferred(),
    release = deferred();
  let paused = false;
  const db = observeStatements(env.DB, async (sql) => {
    if (!paused && /UPDATE accounts/i.test(sql)) {
      paused = true;
      entered.resolve();
      await release.promise;
    }
  });
  const first = call(row.id, db, snapshot);
  expect(
    await Promise.race([entered.promise.then(() => "paused"), first.then(() => "finished")]),
  ).toBe("paused");
  expect(await call(row.id, env.DB, snapshot)).toMatchObject({ status: 200 });
  release.resolve();
  expect(await first).toMatchObject({ status: 200 });
  expect(google.events.filter((e) => e === "refresh")).toHaveLength(2);
  expect(new Set(google.gmailTokens).size).toBe(2);
});
it.each(["reconnect", "remove", "reset"])(
  "does not let a late refresh overwrite an owner %s",
  async (change) => {
    const row = await seedAccount({ sub: "personal", access_expires_at: NOW });
    const b = await ownerBrowser();
    const flow = change === "reconnect" ? await start(b, row.id) : null;
    const entered = deferred(),
      release = deferred();
    const db = observeStatements(env.DB, async (sql) => {
      if (/UPDATE accounts/i.test(sql)) {
        entered.resolve();
        await release.promise;
      }
    });
    const pending = call(row.id, db);
    expect(
      await Promise.race([entered.promise.then(() => "paused"), pending.then(() => "finished")]),
    ).toBe("paused");
    if (change === "reset") await resetOwner();
    else if (change === "remove")
      expect(await (await b.post(`/accounts/${row.id}/remove`)).json()).toEqual({ outcome: "ok" });
    else await finish(b, flow!.url);
    const before = await accounts();
    release.resolve();
    const result = await pending;
    expect(await accounts()).toEqual(before);
    if (change === "reconnect") {
      expect(result).toMatchObject({ status: 200 });
      expect(google.gmailTokens).toEqual([`Bearer ${google.issuedAccess.at(-1)}`]);
    } else {
      expect(result).toMatchObject({ error: "AccountGone" });
      expect(google.gmailTokens).toEqual([]);
    }
    if (change === "reset") {
      expect(await accounts()).toEqual([]);
      expect(textOf(await (await b.get("/accounts")).text())).toContain("No Google accounts yet");
    }
  },
);
it.each([200, 401])(
  "resends only the current request once after a fresh token gets 401, returning %s",
  async (status) => {
    const row = await seedAccount();
    expect(await call(row.id)).toMatchObject({ status: 200 });
    google.gmailAnswers = [401, status];
    expect(await call(row.id)).toMatchObject({ status });
    expect(google.events).toEqual(["gmail", "gmail", "refresh", "gmail"]);
    expect(google.gmailTokens[0]).toBe(google.gmailTokens[1]);
    expect(google.gmailTokens[2]).not.toBe(google.gmailTokens[1]);
  },
);
it("does not send Gmail a refreshed token whose database write failed", async () => {
  const row = await seedAccount({ access_expires_at: NOW });
  expect(await call(row.id, statementFailingDb(/accounts/))).toMatchObject({
    error: "Unavailable",
  });
  expect(google.events).toEqual(["refresh"]);
});
it("restores missing-access status after an admin block clears without inventing scopes", async () => {
  const row = await seedAccount({
    access_expires_at: NOW,
    scopes: JSON.stringify(SCOPES.slice(0, 2)),
  });
  const b = await ownerBrowser();
  const page = async () => textOf(await (await b.get("/accounts")).text());
  expect(await page()).toContain("Missing access.");
  google.refreshAnswers = ["admin_policy_enforced", "ok"];
  expect(await call(row.id)).toMatchObject({ error: "BlockedByAdmin" });
  expect(await page()).toContain("Blocked by admin.");
  vi.spyOn(Date, "now").mockReturnValue(NOW + 600001);
  expect(await call(row.id)).toMatchObject({ status: 200 });
  expect(await page()).toContain("Missing access.");
  expect(await page()).not.toContain("Ready");
});
it.each(["refresh", "access"])(
  "rejects swapped or corrupted %s ciphertext before contacting Google",
  async (field) => {
    const first = await seedAccount({
      access_expires_at: field === "refresh" ? NOW : NOW + 3000000,
    });
    const second = await seedAccount({
      email: "alex.projects@example.com",
      access_expires_at: field === "refresh" ? NOW : NOW + 3000000,
    });
    const column = field === "refresh" ? "refresh_token" : "access_token";
    await env.DB.prepare(`UPDATE accounts SET ${column} = ? WHERE id = ?`)
      .bind(second[column], first.id)
      .run();
    const parts = second[column]!.split(".");
    const ciphertext = parts[3]!;
    parts[3] = (ciphertext[0] === "A" ? "B" : "A") + ciphertext.slice(1);
    await env.DB.prepare(`UPDATE accounts SET ${column} = ? WHERE id = ?`)
      .bind(parts.join("."), second.id)
      .run();
    for (const r of [first, second])
      expect(await call(r.id)).toMatchObject({ error: "NeedsReconnect" });
    expect(google.events).toEqual([]);
    for (const r of await accounts())
      expect(r).toMatchObject({
        health: "needs_reconnect",
        refresh_token: null,
        access_token: null,
      });
  },
);
it("keeps ciphertexts decryptable across refreshes, admin recovery, and rename", async () => {
  const row = await seedAccount({ access_expires_at: NOW });
  for (let i = 0; i < 2; i++) {
    await env.DB.prepare("UPDATE accounts SET access_expires_at = ? WHERE id = ?")
      .bind(NOW, row.id)
      .run();
    expect(await call(row.id)).toMatchObject({ status: 200 });
  }
  google.gmailAnswers = [401];
  google.refreshAnswers = ["admin_policy_enforced", "ok"];
  expect(await call(row.id)).toMatchObject({ error: "BlockedByAdmin" });
  vi.spyOn(Date, "now").mockReturnValue(NOW + 600001);
  expect(await call(row.id)).toMatchObject({ status: 200 });
  const b = await ownerBrowser();
  expect(await (await b.post(`/accounts/${row.id}/name`, { name: "Work" })).json()).toEqual({
    outcome: "ok",
  });
  const current = (await accounts())[0]!;
  for (const field of ["refresh", "access"] as const)
    expect(await fixtureOpen(`${row.id}:${field}`, current[`${field}_token`]!)).toContain(MARKER);
});
it("uses a supplied fresh credential without any database round trips before Gmail", async () => {
  const row = await seedAccount();
  const snapshot = await credential(row.id);
  let trips = 0;
  const db = observeStatements(env.DB, () => {
    trips++;
  });
  expect(await call(row.id, db, snapshot)).toMatchObject({ status: 200 });
  expect(trips).toBe(0);
  expect(google.events).toEqual(["gmail"]);
});
it("reports a lost Gmail response separately and never resends that request", async () => {
  const row = await seedAccount();
  google.gmailAnswers = ["lost"];
  expect(await call(row.id)).toMatchObject({ error: "RequestLost" });
  expect(google.events).toEqual(["gmail"]);
});

it("does not revive a revoked account with an earlier successful refresh", async () => {
  const row = await seedAccount({ access_expires_at: NOW });
  const snapshot = await credential(row.id);
  const entered = deferred(),
    release = deferred();
  const db = observeStatements(env.DB, async (sql) => {
    if (/UPDATE accounts/i.test(sql)) {
      entered.resolve();
      await release.promise;
    }
  });
  const pending = call(row.id, db, snapshot);
  try {
    expect(
      await Promise.race([entered.promise.then(() => "paused"), pending.then(() => "finished")]),
    ).toBe("paused");
    google.refreshAnswers = ["invalid_grant"];
    expect(await call(row.id, env.DB, snapshot)).toMatchObject({ error: "NeedsReconnect" });
    release.resolve();
    expect(await pending).toMatchObject({ error: "NeedsReconnect" });
    expect((await accounts())[0]).toMatchObject({
      health: "needs_reconnect",
      refresh_token: null,
      access_token: null,
    });
    expect(google.gmailTokens).toEqual([]);
  } finally {
    release.resolve();
    await pending;
  }
});

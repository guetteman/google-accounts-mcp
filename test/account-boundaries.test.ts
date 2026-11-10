import { env } from "cloudflare:workers";
import { Effect } from "effect";
import { expect, it, vi } from "vite-plus/test";
import "./support/account-checks";
import {
  accounts,
  call,
  finish,
  fixtureOpen,
  NOW,
  ownerBrowser,
  seedAccount,
  start,
} from "./support/accounts";
import { deferred, google } from "./support/google";
import { observeStatements, setOwner } from "./support/db";
import { ORIGIN, OWNER_EMAIL, testEnv } from "./support/worker";
import { decodeCredential, accountStatus } from "../src/accounts/model";
import { listAccounts } from "../src/accounts/store";
import { parseGrantedScopes } from "../src/google/client";
import { readOwner } from "../src/owner/owner";

const outcome = (response: Response) => {
  const cookie = response.headers
    .getSetCookie()
    .find((value) => value.startsWith("__Host-accounts-outcome="));
  return JSON.parse(decodeURIComponent(cookie!.split(";", 1)[0]!.split("=")[1]!));
};

for (const action of [
  "name",
  "remove",
  "reconnect",
  "add",
  "duplicate",
  "duplicate address",
] as const) {
  it.each(["generation", "email"])(
    `refuses ${action === "name" ? "rename" : action} after the owner's %s changes before the write`,
    async (field) => {
      const row =
        action === "add"
          ? null
          : await seedAccount({
              sub: action === "duplicate address" ? "different-subject" : "personal",
            });
      const b = await ownerBrowser();
      const url =
        action === "reconnect" || action === "add" || action.startsWith("duplicate")
          ? (await start(b, action === "reconnect" ? row!.id : undefined)).url
          : null;
      const before = await accounts();
      let changed = false;
      const db = observeStatements(env.DB, async (sql) => {
        if (!changed && /^(INSERT INTO accounts|UPDATE accounts)/.test(sql)) {
          changed = true;
          await setOwner({
            state: "pinned",
            generation: field === "generation" ? 2 : 1,
            email: field === "email" ? "new.owner@example.com" : OWNER_EMAIL,
          });
        }
      });
      const response = url
        ? await b.get(google.issueCode(url), { env: testEnv({ DB: db }) })
        : await b.post(
            `/accounts/${row!.id}/${action}`,
            { name: "Renamed" },
            { env: testEnv({ DB: db }) },
          );
      expect(changed).toBe(true);
      if (url)
        expect(outcome(response).kind).toBe(action === "reconnect" ? "changed" : "didnt_finish");
      else expect(await response.json()).toEqual({ outcome: "not_found" });
      expect(await accounts()).toEqual(before);
    },
  );
}

it.each(["generation", "email"])(
  "does not list accounts after the owner's %s changes",
  async (field) => {
    await seedAccount();
    const row = await Effect.runPromise(readOwner(env.DB));
    const owner = { generation: row.generation, email: row.email! };
    await setOwner({
      state: "pinned",
      generation: field === "generation" ? 2 : 1,
      email: field === "email" ? "new.owner@example.com" : OWNER_EMAIL,
    });
    expect(
      await Effect.runPromise(
        listAccounts(
          env.DB,
          owner,
          new Uint8Array(32).fill(187) as import("../src/config").TokenKey,
        ),
      ),
    ).toEqual([]);
  },
);

it.each([
  { iss: "https://evil.example/accounts.google.com" },
  { aud: [testEnv().GOOGLE_CLIENT_ID] },
  { sub: "" },
  { exp: String(Math.floor(NOW / 1000) + 3600) },
])("refuses an ID token with invalid identity claims: %j", async (claims) => {
  const b = await ownerBrowser();
  expect((await finish(b, (await start(b)).url, { claims })).text).toContain(
    "Google refused this server's OAuth client. Check GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET. Nothing changed.",
  );
  expect(await accounts()).toEqual([]);
});

it.each([
  { id: "bad" },
  { email: "bad" },
  { email: "Alex.Personal@example.com" },
  { version: 0 },
  { version: 1.5 },
  { health: "unknown" },
  { refresh_token: null },
  { health: "needs_reconnect" },
  { health: "needs_reconnect", refresh_token: null },
  { health: "blocked_by_admin", blocked_until: null },
  { access_expires_at: "tomorrow" },
])("refuses a malformed stored credential: %j", async (override) => {
  const row = await seedAccount();
  expect(decodeCredential(row)).not.toBeNull();
  expect(decodeCredential({ ...row, ...override })).toBeNull();
});

it.each(["invalid state", "cookie prefix", "exactly ten minutes"])(
  "refuses a callback with %s without exchanging its code",
  async (kind) => {
    const b = await ownerBrowser();
    const { url } = await start(b);
    const callback = new URL(google.issueCode(url), ORIGIN);
    const state = url.searchParams.get("state")!;
    const value = b.cookies.get(ORIGIN)!.get(`__Host-g-${state}`)!;
    let cookie = `__Host-g-${state}=${value}`;
    if (kind === "invalid state") {
      callback.searchParams.set("state", "invalid!");
      cookie = `__Host-g-invalid!=${value}`;
    }
    if (kind === "cookie prefix") cookie = `__Host-g-${state}-extra=${value}`;
    if (kind === "exactly ten minutes") vi.spyOn(Date, "now").mockReturnValue(NOW + 600000);
    const response = await b.get(callback.href, { headers: { Cookie: cookie } });
    expect(outcome(response)).toEqual({ kind: "didnt_finish" });
    expect(await accounts()).toEqual([]);
    expect(google.events).toEqual([]);
  },
);

it("checks Google again at the exact end of the admin block window", async () => {
  const row = await seedAccount({ health: "blocked_by_admin", blocked_until: NOW + 600000 });
  vi.spyOn(Date, "now").mockReturnValue(NOW + 600000);
  expect(await call(row.id)).toMatchObject({ status: 200 });
  expect(google.events).toEqual(["refresh", "gmail"]);
  expect((await accounts())[0]).toMatchObject({ health: "ready", blocked_until: null });
});

it("shows Needs reconnect before missing Gmail permissions", () => {
  expect(accountStatus("needs_reconnect", parseGrantedScopes(""))).toEqual({
    kind: "needs_reconnect",
  });
});

it("disconnects exactly the stored refresh token from Google", async () => {
  const row = await seedAccount();
  const refresh = await fixtureOpen(`${row.id}:refresh`, row.refresh_token!);
  const b = await ownerBrowser();
  expect(await (await b.post(`/accounts/${row.id}/remove`, { disconnect: "1" })).json()).toEqual({
    outcome: "ok",
  });
  expect(google.revokedTokens).toEqual([refresh]);
});

it("reports not found when another removal finishes first", async () => {
  const row = await seedAccount();
  const b = await ownerBrowser();
  const entered = deferred(),
    release = deferred();
  const db = observeStatements(env.DB, async (sql) => {
    if (sql.startsWith("UPDATE accounts")) {
      entered.resolve();
      await release.promise;
    }
  });
  const pending = b.post(`/accounts/${row.id}/remove`, {}, { env: testEnv({ DB: db }) });
  try {
    await entered.promise;
    expect(await (await b.post(`/accounts/${row.id}/remove`)).json()).toEqual({ outcome: "ok" });
    const before = await accounts();
    release.resolve();
    expect(await (await pending).json()).toEqual({ outcome: "not_found" });
    expect(await accounts()).toEqual(before);
  } finally {
    release.resolve();
    await pending;
  }
});

it("hides accounts created after an owner reset from an earlier authorization", async () => {
  const b = await ownerBrowser();
  const old = await Effect.runPromise(readOwner(env.DB));
  const owner = { generation: old.generation, email: old.email! };
  const { url } = await start(b);
  let changed = false;
  const db = observeStatements(env.DB, async (sql) => {
    if (!changed && sql.startsWith("INSERT INTO accounts")) {
      changed = true;
      await setOwner({ state: "pinned", generation: 2, email: OWNER_EMAIL });
      await seedAccount({ generation: 2, sub: "personal" });
    }
  });
  expect(outcome(await b.get(google.issueCode(url), { env: testEnv({ DB: db }) }))).toEqual({
    kind: "didnt_finish",
  });
  expect(
    await Effect.runPromise(
      listAccounts(env.DB, owner, new Uint8Array(32).fill(187) as import("../src/config").TokenKey),
    ),
  ).toEqual([]);
  expect(await accounts()).toHaveLength(1);
});

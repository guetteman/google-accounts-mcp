import { HttpResponse } from "msw";
import { env } from "cloudflare:workers";
import { Effect, Result } from "effect";
import { expect, it, vi } from "vite-plus/test";
import { recordedConsole } from "./support/account-checks";
import {
  accounts,
  call,
  credential,
  finish,
  NOW,
  ownerBrowser,
  seedAccount,
  start,
} from "./support/accounts";
import { google, deferred } from "./support/google";
import { dump } from "./support/db";
import { testEnv, textOf } from "./support/worker";
import { readConfig } from "../src/config";
import { withGoogle } from "../src/accounts/tokens";
import { readOwner } from "../src/owner/owner";
import { loadCredential } from "../src/accounts/store";
import { seedConnection } from "./support/connections";

it.each(["success", "block"])(
  "keeps a newer %s when an earlier admin rejection arrives late",
  async (newer) => {
    const row = await seedAccount({ access_expires_at: NOW });
    const snapshot = await credential(row.id);
    const entered = deferred(),
      release = deferred();
    google.refreshAnswers = [
      async () => {
        entered.resolve();
        await release.promise;
        return HttpResponse.json({ error: "admin_policy_enforced" }, { status: 400 });
      },
    ];
    const pending = call(row.id, env.DB, snapshot);
    try {
      await entered.promise;
      google.refreshAnswers = [newer === "success" ? "ok" : "admin_policy_enforced"];
      expect(await call(row.id, env.DB, snapshot)).toMatchObject(
        newer === "success" ? { status: 200 } : { error: "BlockedByAdmin" },
      );
      const before = await accounts();
      vi.spyOn(Date, "now").mockReturnValue(NOW + 1000);
      release.resolve();
      expect(await pending).toMatchObject(
        newer === "success" ? { status: 200 } : { error: "BlockedByAdmin" },
      );
      expect(await accounts()).toEqual(before);
      expect(google.refreshTokens).toHaveLength(2);
      if (newer === "success") expect(new Set(google.gmailTokens).size).toBe(1);
      else
        expect(before[0]).toMatchObject({
          blocked_until: NOW + 600000,
          access_token: null,
          access_expires_at: null,
        });
    } finally {
      release.resolve();
      await pending;
    }
  },
);

it.each(["fresh", "expired"])(
  "preserves a %s credential when TOKEN_KEY is wrong and recovers when restored",
  async (age) => {
    const row = await seedAccount({ access_expires_at: age === "fresh" ? NOW + 3000000 : NOW });
    const before = await dump();
    expect(
      await call(row.id, env.DB, undefined, testEnv({ TOKEN_KEY: "c".repeat(64) })),
    ).toMatchObject({ error: "Unavailable" });
    expect(await dump()).toEqual(before);
    expect(google.events).toEqual([]);
    expect(recordedConsole()).toEqual([["TOKEN_KEY does not match the stored tokens"]]);
    expect(await call(row.id)).toMatchObject({ status: 200 });
  },
);

it("removes local access without revoking when the token belongs to another key", async () => {
  const row = await seedAccount();
  const b = await ownerBrowser();
  expect(
    await (
      await b.post(
        `/accounts/${row.id}/remove`,
        { disconnect: "1" },
        { env: testEnv({ TOKEN_KEY: "c".repeat(64) }) },
      )
    ).json(),
  ).toEqual({ outcome: "ok" });
  expect(google.events).toEqual([]);
  expect(textOf(await (await b.get("/accounts")).text())).toContain(
    "Google didn't confirm the disconnect.",
  );
});

it("names refused OAuth client settings instead of suggesting a transient Google outage", async () => {
  const b = await ownerBrowser();
  google.exchangeAnswer = "invalid_client";
  expect((await finish(b, (await start(b)).url)).text).toContain(
    "Google refused this server's OAuth client. Check GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET. Nothing changed.",
  );
  expect(await accounts()).toEqual([]);
});

it.each([
  { GOOGLE_CLIENT_SECRET: " " },
  { GOOGLE_CLIENT_SECRET: "fake\n" },
  { GOOGLE_CLIENT_SECRET: " fake" },
  { TOKEN_KEY: "a".repeat(32) },
  { GOOGLE_CLIENT_ID: "test-client" },
])("rejects malformed Google settings without echoing their value: %j", async (overrides) => {
  const b = await ownerBrowser();
  const r = await b.get("/accounts", { env: testEnv(overrides) });
  expect(r.status).toBe(503);
  expect(await r.text()).toContain(Object.keys(overrides)[0]);
});

it("reports an unreadable stored credential as a local failure rather than a missing account", async () => {
  const row = await seedAccount();
  const owner = await Effect.runPromise(readOwner(env.DB));
  await env.DB.prepare("UPDATE accounts SET scopes = '[]', email = 'not-an-email' WHERE id = ?")
    .bind(row.id)
    .run();
  const result = await Effect.runPromise(
    Effect.result(
      loadCredential(env.DB, { generation: owner.generation, email: owner.email! }, row.id),
    ),
  );
  expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "Unavailable" } });
});

it("does not blame Google or use an unpersisted token when local encryption fails", async () => {
  const row = await seedAccount({ access_expires_at: NOW });
  const before = await dump();
  vi.spyOn(crypto.subtle, "encrypt").mockRejectedValue(new Error("local encryption failed"));
  expect(await call(row.id)).toMatchObject({ error: "Unavailable" });
  expect(await dump()).toEqual(before);
  expect(google.events).toEqual(["refresh"]);
});

it("surfaces a caller's request construction error as a defect without contacting Gmail", async () => {
  const row = await seedAccount();
  const config = readConfig(testEnv());
  if (Result.isFailure(config)) throw new Error("Invalid test config");
  const owner = await Effect.runPromise(readOwner(env.DB));
  await expect(
    Effect.runPromise(
      Effect.result(
        withGoogle(
          {
            db: env.DB,
            config: config.success,
            owner: { generation: owner.generation, email: owner.email! },
            now: Date.now,
          },
          await credential(row.id),
          () => {
            throw new Error("caller construction failed");
          },
        ),
      ),
    ),
  ).rejects.toThrow("caller construction failed");
  expect(google.events).toEqual([]);
});

it.each(["account rename", "account remove", "connection rename", "connection revoke"])(
  "refuses a missing or malformed form for %s with 400 and no writes",
  async (action) => {
    const account = await seedAccount();
    const connection = await seedConnection();
    const b = await ownerBrowser();
    const path = action.startsWith("account")
      ? `/accounts/${account.id}/${action.endsWith("rename") ? "name" : "remove"}`
      : `/connections/${connection.id}/${action.endsWith("rename") ? "name" : "revoke"}`;
    const before = await dump();
    for (const headers of [
      {},
      { "Content-Type": "multipart/form-data; boundary=missing" },
    ] as Record<string, string>[]) {
      const response = await b.request(path, { method: "POST", headers });
      expect(response.status).toBe(400);
      expect(await dump()).toEqual(before);
    }
    expect(google.events).toEqual([]);
  },
);

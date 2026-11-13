import { env } from "cloudflare:workers";
import { expect, it } from "vite-plus/test";
import type { TestEnv } from "./env";
import { activityFixture, activityProps, record } from "./support/activity";
import { seedAccount } from "./support/accounts";

it("backfills named and other accounts once per record without losing the existing log", async () => {
  const f = await activityFixture();
  const source = await seedAccount({ name: "Source", email: "source@example.com" });
  await env.DB.batch(
    [
      "DROP TRIGGER calls_accounts",
      "DROP TABLE call_accounts",
      "DROP INDEX calls_connection",
      "DROP INDEX calls_outcome",
      "DROP INDEX approvals_call",
    ].map((sql) => env.DB.prepare(sql)),
  );
  await record(f.connection.id, f.account.id, { id: 1 });
  await record(f.connection.id, null, {
    id: 2,
    also: [{ account: source.id, tool: "get_attachment" }],
  });
  await record(f.connection.id, f.account.id, {
    id: 3,
    also: [
      { account: source.id, tool: "get_attachment" },
      { account: source.id, tool: "get_attachment" },
      { account: f.account.id, tool: "get_attachment" },
    ],
  });
  const old = (await env.DB.prepare("SELECT * FROM calls ORDER BY id").all()).results;
  const migration = (env as TestEnv).TEST_MIGRATIONS.find((m) => m.name === "0008_activity.sql");
  expect(migration).toBeDefined();
  await env.DB.batch(migration!.queries.map((sql) => env.DB.prepare(sql)));
  expect((await env.DB.prepare("SELECT * FROM calls ORDER BY id").all()).results).toEqual(old);
  for (const [account, ids] of [
    [f.account, [3, 1]],
    [source, [3, 2]],
  ] as const) {
    const response = await f.browser.get(`/activity?account=${account.id}`);
    expect(response.status).toBe(200);
    expect(activityProps(await response.text()).load.records.map((r) => r.id)).toEqual(ids);
  }
  expect(
    (
      await env.DB.prepare(
        "SELECT account_id,call_id FROM call_accounts ORDER BY account_id,call_id",
      ).all()
    ).results,
  ).toHaveLength(4);
});

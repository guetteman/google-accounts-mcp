import { env } from "cloudflare:workers";
import { expect, it } from "vite-plus/test";
import { activityFixture, activityProps, link } from "./support/activity";
import { seedAccount } from "./support/accounts";
import { NOW, seedConnection } from "./support/connections";
import { readRecordingDb } from "./support/db";
import { testEnv } from "./support/worker";

it("bounds every request's reads on 1,000,000 records, including a full load of approvals", async () => {
  const f = await activityFixture();
  const rare = await seedConnection({ name: "Ten old records" });
  const approved = await seedConnection({ name: "Approved calls" });
  const secondary = await seedAccount({ name: "Source", email: "source@example.com" });
  await env.DB.prepare(`WITH RECURSIVE n(id) AS (VALUES(1) UNION ALL SELECT id+1 FROM n WHERE id<1000000)
    INSERT INTO calls (id,connection_id,account_id,tool,at,outcome,also)
    SELECT id, CASE WHEN id<=10 THEN ?1 WHEN id BETWEEN 499976 AND 500001 THEN ?2 ELSE ?3 END,
      CASE WHEN id%2=0 THEN ?4 ELSE NULL END, 'read_thread', ?5-id*60000,
      CASE WHEN id<=3 THEN 'failed' WHEN id%7=0 THEN NULL ELSE 'success' END,
      CASE WHEN id%100=0 THEN json_array(json_object('account',?6,'tool','get_attachment')) ELSE NULL END FROM n`)
    .bind(rare.id, approved.id, f.connection.id, f.account.id, NOW, secondary.id)
    .run();
  await env.DB.prepare(`WITH RECURSIVE n(id) AS (VALUES(499976) UNION ALL SELECT id+1 FROM n WHERE id<500001)
    INSERT INTO approvals (id,generation,connection_id,call_id,tool,uses,created_at,expires_at,state,decided_at)
    SELECT printf('approval-%d',id),1,?1,id,'read_thread','[]',?2,?2+3600000,'approved',?2 FROM n`)
    .bind(approved.id, NOW)
    .run();
  const descending = (top: number, step = 1) =>
    Array.from({ length: 25 }, (_, i) => top - i * step);
  const cases = [
    { name: "first load", query: "", ids: descending(1000000), older: true, bound: 78 },
    { name: "deep load", query: "before=750000", ids: descending(749999), older: true, bound: 78 },
    {
      name: "many on connection",
      query: `connection=${f.connection.id}`,
      ids: descending(1000000),
      older: true,
      bound: 78,
    },
    {
      name: "ten old on connection",
      query: `connection=${rare.id}`,
      ids: Array.from({ length: 10 }, (_, i) => 10 - i),
      older: false,
      bound: 78,
    },
    {
      name: "many with outcome",
      query: "outcome=success",
      ids: Array.from({ length: 40 }, (_, i) => 1000000 - i)
        .filter((id) => id % 7 !== 0)
        .slice(0, 25),
      older: true,
      bound: 78,
    },
    {
      name: "three with outcome",
      query: "outcome=failed",
      ids: [3, 2, 1],
      older: false,
      bound: 78,
    },
    {
      name: "unknown",
      query: "outcome=unknown",
      ids: descending(999999, 7),
      older: true,
      bound: 78,
    },
    {
      name: "named account",
      query: `account=${f.account.id}`,
      ids: descending(1000000, 2),
      older: true,
      bound: 104,
    },
    {
      name: "secondary account",
      query: `account=${secondary.id}`,
      ids: descending(1000000, 100),
      older: true,
      bound: 104,
    },
    {
      name: "25 approved records",
      query: `connection=${approved.id}`,
      ids: descending(500001),
      older: true,
      bound: 78,
    },
  ];
  // The two lean lists, including their owner guards, read 7 and 5 rows for this fixture.
  // The request's owner gate reads one row and its pin/check reads three.
  const listRows = 7 + 5;
  const ownerRows = 1 + 3;
  for (const sample of cases) {
    const { db, reads } = readRecordingDb();
    const response = await f.browser.get(`/activity${sample.query ? `?${sample.query}` : ""}`, {
      env: testEnv({ DB: db }),
    });
    expect(response.status, sample.name).toBe(200);
    const html = await response.text();
    const props = activityProps(html);
    expect(
      props.load.records.map((r) => r.id),
      sample.name,
    ).toEqual(sample.ids);
    // Read the IDs back from the times in the actual HTML, whose fixture time is NOW - ID minutes.
    const shown = [
      ...new Set(
        [...html.matchAll(/<time dateTime="([^"]+)"/g)].map(
          (m) => (NOW - Date.parse(m[1]!)) / 60000,
        ),
      ),
    ];
    expect(shown, sample.name).toEqual(sample.ids);
    expect(link(html, "Older") !== null, sample.name).toBe(sample.older);
    if (sample.name === "25 approved records")
      expect(props.load.records.every((r) => r.approval?.state === "approved")).toBe(true);
    const total = reads.reduce((sum, r) => sum + r.rows, 0);
    expect(reads, sample.name).toHaveLength(5);
    console.info(
      `Activity reads: ${sample.name}: ${total} <= ${sample.bound + listRows + ownerRows}; statements: ${reads.map((r) => r.rows).join(", ")}`,
    );
    expect(reads.slice(0, 4).reduce((sum, read) => sum + read.rows, 0)).toBeLessThanOrEqual(
      listRows + ownerRows,
    );
    expect(reads[4]!.rows, sample.name).toBeLessThanOrEqual(sample.bound);
    expect(total, sample.name).toBeLessThanOrEqual(sample.bound + listRows + ownerRows);
  }
}, 30000);

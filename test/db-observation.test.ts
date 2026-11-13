import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { dump, readRecordingDb, writeRecordingDb } from "./support/db";

// A recorder that misses no-op writes would let the unchanged-dump assertions hide them again.
describe("D1 write observation", () => {
  it("records every prepared write execution method and batch even when no rows change", async () => {
    const { db, writes } = writeRecordingDb();
    const before = await dump();
    const update = "UPDATE owner SET email = lower(email) WHERE id = ? RETURNING id";
    await db.prepare(update).bind(-1).run();
    await db.prepare(update).bind(-1).all();
    await db.prepare(update).bind(-1).first();
    await db.prepare(update).bind(-1).raw();
    const insert = "INSERT INTO owner (id, state, generation) SELECT 1, 'unpinned', 1 WHERE 0";
    const replace = "REPLACE INTO owner (id, state, generation) SELECT 1, 'unpinned', 1 WHERE 0";
    const remove = "DELETE FROM owner WHERE 0";
    await db.batch([db.prepare(insert), db.prepare(replace), db.prepare(remove)]);
    await db.prepare("SELECT * FROM owner").all();
    await db.batch([db.prepare("SELECT * FROM owner")]);
    expect(writes).toEqual([update, update, update, update, insert, replace, remove]);
    expect(await dump()).toEqual(before);
  });

  it("records writes executed as SQL text and allows reads to execute", async () => {
    const { db, writes } = writeRecordingDb();
    const before = await dump();
    await db.exec("UPDATE owner SET email = lower(email)\nDELETE FROM owner WHERE 0");
    await db.exec("SELECT * FROM owner");
    expect(writes.map((sql) => sql.trim())).toEqual([
      "UPDATE owner SET email = lower(email)",
      "DELETE FROM owner WHERE 0",
    ]);
    expect(await dump()).toEqual(before);
  });
});

it("includes both KV namespaces in an unchanged-state snapshot", async () => {
  await env.OAUTH_KV.put("oauth-proof", "oauth-value");
  await env.FILES_KV.put("file:proof", "file-value");
  const snapshot = await dump();
  expect(snapshot.OAUTH_KV).toEqual([{ name: "oauth-proof", value: "oauth-value" }]);
  expect(snapshot.FILES_KV).toEqual([{ name: "file:proof", value: "file-value" }]);
});

it("measures first, column-first, all, run, raw and each batch statement without losing their results", async () => {
  await env.DB.prepare("CREATE TABLE read_samples (id INTEGER PRIMARY KEY, value TEXT)").run();
  await env.DB.prepare(
    "INSERT INTO read_samples VALUES (1, 'one'), (2, 'two'), (3, 'three')",
  ).run();
  const { db, reads } = readRecordingDb();
  expect(await db.prepare("SELECT value FROM read_samples WHERE id = 2").first()).toEqual({
    value: "two",
  });
  expect(await db.prepare("SELECT value FROM read_samples WHERE id = 1").first("value")).toBe(
    "one",
  );
  expect((await db.prepare("SELECT value FROM read_samples WHERE id = 3").all()).results).toEqual([
    { value: "three" },
  ]);
  expect((await db.prepare("SELECT * FROM read_samples WHERE id = 1").run()).results).toEqual([
    { id: 1, value: "one" },
  ]);
  expect(
    await db.prepare("SELECT id, value FROM read_samples WHERE id = 2").raw({ columnNames: true }),
  ).toEqual([
    ["id", "value"],
    [2, "two"],
  ]);
  const batch = await db.batch<{ id: number; value: string }>([
    db.prepare("SELECT * FROM read_samples WHERE id = 1"),
    db.prepare("SELECT * FROM read_samples WHERE id > 1 ORDER BY id"),
  ]);
  expect(batch.map((result) => result.results.map((row) => row.id))).toEqual([[1], [2, 3]]);
  expect(reads.map((read) => read.rows)).toEqual([1, 1, 1, 1, 1, 1, 2]);
});

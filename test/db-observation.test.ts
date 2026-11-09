import { describe, expect, it } from "vite-plus/test";
import { dump, writeRecordingDb } from "./support/db";

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

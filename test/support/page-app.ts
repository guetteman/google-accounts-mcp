import { env } from "cloudflare:workers";
import { app } from "../../src/http/app";
import { ownerOnly } from "../../src/owner/routes";

export const WRITE_PATH = "/__test/owner-write";
export async function prepareWrites() {
  await env.DB.prepare("CREATE TABLE test_writes (generation INTEGER, value TEXT)").run();
}

// Runs through the real default export, gate, page guards, and owner middleware.
app.post(WRITE_PATH, ownerOnly, async (c) => {
  const { generation } = c.get("owner");
  await c.env.DB.prepare(`INSERT INTO test_writes SELECT ?, 'written' FROM owner
    WHERE id = 1 AND state = 'pinned' AND generation = ?`)
    .bind(generation, generation)
    .run();
  return c.json({ generation });
});

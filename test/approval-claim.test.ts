import { env } from "cloudflare:workers";
import { expect, it } from "vite-plus/test";
import { NOW, pinOwner, resetOwner, seedConnection } from "./support/connections";
import { setOwner } from "./support/db";
import { OWNER_EMAIL } from "./support/worker";

// The SQL predicate is the specified public seam for #4. Load it only inside the test, so
// absent production code produces an assertion failure rather than an import/setup error.
const stores = import.meta.glob<{
  activeWhere: (p: { now: string; ownerEmail: string }) => string;
}>("../src/connections/store.ts");
it.each(["active", "revoked", "expired", "mismatched owner", "resetting owner", "reset"])(
  "claims an approval atomically only when its connection is active during %s",
  async (state) => {
    await pinOwner();
    const row = await seedConnection();
    await env.DB.prepare(
      "CREATE TABLE approvals (id TEXT PRIMARY KEY, claimed_at INTEGER) STRICT",
    ).run();
    await env.DB.prepare("INSERT INTO approvals VALUES ('approval', NULL)").run();
    if (state === "revoked")
      await env.DB.prepare("UPDATE connections SET state = 'revoked', revoked_at = ? WHERE id = ?")
        .bind(NOW, row.id)
        .run();
    if (state === "expired")
      await env.DB.prepare("UPDATE connections SET expires_at = ? WHERE id = ?")
        .bind(NOW, row.id)
        .run();
    // Test the public predicate's pinned-state requirement independently of generation.
    if (state === "resetting owner")
      await setOwner({ state: "resetting", generation: 1, email: OWNER_EMAIL });
    if (state === "reset") {
      await resetOwner();
      await setOwner({ state: "pinned", generation: 2, email: OWNER_EMAIL });
    }
    const load = stores["../src/connections/store.ts"];
    expect(load, "shared active predicate must be implemented for approval claims").toBeDefined();
    const { activeWhere } = await load!();
    const claim = () =>
      env.DB.prepare(
        `UPDATE approvals SET claimed_at = ?1 WHERE id = ?2 AND claimed_at IS NULL AND EXISTS (SELECT 1 FROM connections c WHERE c.id = ?3 AND ${activeWhere({ now: "?1", ownerEmail: "?4" })}) RETURNING id`,
      )
        .bind(
          NOW,
          "approval",
          row.id,
          state === "mismatched owner" ? "new.owner@example.com" : OWNER_EMAIL,
        )
        .all<{ id: string }>();
    const claimed = await claim();
    expect(claimed.results).toEqual(state === "active" ? [{ id: "approval" }] : []);
    expect(await env.DB.prepare("SELECT claimed_at FROM approvals").first()).toEqual({
      claimed_at: state === "active" ? NOW : null,
    });
    // Even an active connection cannot run the same approval twice.
    expect((await claim()).results).toEqual([]);
  },
);

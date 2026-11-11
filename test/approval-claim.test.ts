import { env } from "cloudflare:workers";
import { Effect, Result } from "effect";
import { expect, it } from "vite-plus/test";
import "./support/account-checks";
import { decisionStatement, readApproval } from "../src/approvals/store";
import { parseApprovalId } from "../src/approvals/model";
import { approvalView } from "../src/approvals/view";
import { readConfig } from "../src/config";
import { readOwner } from "../src/owner/owner";
import { NOW } from "./support/accounts";
import { resetOwner } from "./support/connections";
import { setOwner } from "./support/db";
import { OWNER_EMAIL, testEnv } from "./support/worker";
import { fixture } from "./support/permissions";
import { ask, setting } from "./support/approvals";
it.each(["active", "revoked", "expired", "mismatched owner", "resetting owner", "reset"])(
  "claims an approval atomically only when its connection is active during %s",
  async (state) => {
    const f = await fixture();
    await setting(f, "ask");
    const id = parseApprovalId(await ask(f))!;
    const owner = await Effect.runPromise(readOwner(env.DB));
    const ctx = {
      db: env.DB,
      owner: {
        generation: owner.generation,
        email: OWNER_EMAIL as NonNullable<typeof owner.email>,
      },
    };
    const config = readConfig(testEnv());
    if (Result.isFailure(config)) throw new Error("Invalid test config");
    const row = await Effect.runPromise(readApproval(ctx, id, NOW));
    const view = await approvalView(row!, config.success.tokenKey, NOW);
    if (state === "revoked")
      await env.DB.prepare("UPDATE connections SET state = 'revoked', revoked_at = ? WHERE id = ?")
        .bind(NOW, f.connection.id)
        .run();
    if (state === "expired")
      await env.DB.prepare("UPDATE connections SET expires_at = ? WHERE id = ?")
        .bind(NOW, f.connection.id)
        .run();
    if (state === "mismatched owner")
      await setOwner({ state: "pinned", generation: 1, email: "new.owner@example.com" });
    if (state === "resetting owner")
      await setOwner({ state: "resetting", generation: 1, email: OWNER_EMAIL });
    if (state === "reset") {
      await resetOwner();
      await setOwner({ state: "pinned", generation: 2, email: OWNER_EMAIL });
    }
    const claim = () =>
      env.DB.batch([
        decisionStatement(ctx, {
          id,
          at: NOW,
          claim: crypto.randomUUID(),
          action: "approve",
          snapshot: view.snapshot,
        }),
      ]);
    expect((await claim())[0]!.results).toEqual(state === "active" ? [{ id }] : []);
    expect((await claim())[0]!.results).toEqual([]);
  },
);

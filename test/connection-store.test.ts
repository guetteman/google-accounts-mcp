import { env } from "cloudflare:workers";
import { Effect, Result } from "effect";
import { expect, it } from "vite-plus/test";
import { decodePendingGrant, newConnectionId } from "../src/connections/model";
import { listConnections, redeem } from "../src/connections/store";
import { normalizeEmail, readOwner } from "../src/owner/owner";
import { NOW, pinOwner, resetOwner, rows, seedConnection } from "./support/connections";
import { setOwner } from "./support/db";
import { OWNER_EMAIL } from "./support/worker";

it("does not list a later generation for an owner verified before reset", async () => {
  await pinOwner();
  const oldOwner = await Effect.runPromise(readOwner(env.DB));
  await resetOwner();
  await setOwner({ state: "pinned", generation: 2, email: OWNER_EMAIL });
  await seedConnection({ generation: 2, name: "New generation" });
  const listed = await Effect.runPromise(
    listConnections(env.DB, { generation: oldOwner.generation, email: oldOwner.email! }, NOW),
  );
  expect(listed).toEqual([]);
});

it("refuses redemption without inserting a row when its configured owner differs", async () => {
  await pinOwner();
  const props = decodePendingGrant({
    v: 1,
    connectionId: newConnectionId(),
    name: "Work laptop",
    generation: 1,
  });
  const result = await Effect.runPromise(
    Effect.result(
      redeem(env.DB, {
        props: props!,
        grantId: "test-grant",
        app: "claude-code",
        ownerEmail: normalizeEmail("different.owner@example.com")!,
        now: NOW,
      }),
    ),
  );
  expect(Result.isFailure(result) && result.failure._tag).toBe("NotRedeemable");
  expect(await rows()).toEqual([]);
});

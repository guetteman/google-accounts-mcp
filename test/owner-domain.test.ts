import { env } from "cloudflare:workers";
import { Effect, Result, Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { readConfig } from "../src/config";
import { GenerationSchema, normalizeEmail, signIn, type OwnerIdentity } from "../src/owner/owner";
import { resetPlan } from "../src/owner/reset";
import { requireOwner, signOut, signOutEverywhere } from "../src/owner/session";
import { Browser } from "./support/browser";
import { dump, ownerRow, sessions, setOwner } from "./support/db";
import { ORIGIN, OWNER_EMAIL, testEnv } from "./support/worker";

function config(ownerEmail = OWNER_EMAIL) {
  const result = readConfig(testEnv({ OWNER_EMAIL: ownerEmail }));
  if (Result.isFailure(result)) throw result.failure;
  return result.success;
}

describe("sign-in across Worker versions", () => {
  it("refuses a session when the stored email differs from this Worker's configured owner", async () => {
    await setOwner({ state: "pinned", generation: 1, email: OWNER_EMAIL, google_sub: "sub-a" });
    const otherEmail = normalizeEmail("alex.other@example.com");
    if (!otherEmail) throw new Error("Invalid fixture email");
    const who: OwnerIdentity = { email: otherEmail, googleSub: "sub-a" };
    const before = await dump();

    const result = await Effect.runPromise(
      Effect.result(
        signIn(
          env.DB,
          config(otherEmail),
          who,
          Schema.decodeUnknownSync(GenerationSchema)(1),
          Date.now(),
        ),
      ),
    );

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isSuccess(result)) throw new Error("A different configured email got a session");
    expect(["NotOwner", "StaleFlow"]).toContain(result.failure._tag);
    expect(await sessions()).toEqual([]);
    expect(await dump()).toEqual(before);
  });
});

describe("owner actions started before a reset", () => {
  it.each([
    ["signing out everywhere", signOutEverywhere],
    ["signing out this browser", signOut],
  ] as const)(
    "keeps the new owner's sessions when %s uses an earlier generation",
    async (_label, action) => {
      const oldOwner = new Browser();
      await oldOwner.signInAsOwner();
      const oldSession = await Effect.runPromise(
        requireOwner(
          env.DB,
          config(),
          new Request(`${ORIGIN}/accounts`, {
            headers: { Cookie: `__Host-session=${oldOwner.session}` },
          }),
          Date.now(),
        ),
      );
      const plan = resetPlan({ state: "pinned", generation: oldSession.generation }, Date.now());
      await env.DB.batch(plan.statements.map((sql) => env.DB.prepare(sql)));
      const newOwner = new Browser();
      await newOwner.signInAsOwner({ sub: "sub-new" });
      expect(await ownerRow()).toMatchObject({
        state: "pinned",
        generation: 2,
        google_sub: "sub-new",
      });

      // A hash collision or a reused row must still be constrained by the old action's generation.
      // Normally the hash differs; using the live hash here makes both predicates observable.
      const [liveSession] = await sessions();
      expect(liveSession).toBeDefined();
      const staleAction = { ...oldSession, tokenHash: liveSession!.token_hash };
      const before = await dump();

      await Effect.runPromise(action(env.DB, oldSession));
      expect(await dump()).toEqual(before);
      await Effect.runPromise(action(env.DB, staleAction));

      expect(await dump()).toEqual(before);
      expect((await newOwner.get("/accounts")).status).toBe(200);
    },
  );
});

it("refuses a reset whose next generation exceeds the safe integer range", () => {
  expect(() =>
    resetPlan({ state: "pinned", generation: Number.MAX_SAFE_INTEGER }, Date.now()),
  ).toThrow();
});

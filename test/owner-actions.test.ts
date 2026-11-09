import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { resetPlan } from "../src/owner/reset";
import { access, signAccessJwt } from "./support/access";
import { Browser } from "./support/browser";
import { ACCESS_REFUSED, ACCESS_UNAVAILABLE, NOT_OWNER, MISMATCH } from "./support/copy";
import { dump, ownerInstance, ownerRow, setOwner, writeRecordingDb } from "./support/db";
import { prepareWrites, WRITE_PATH } from "./support/page-app";
import { ORIGIN, OWNER_EMAIL, testEnv, textOf } from "./support/worker";

describe("owner page actions", () => {
  it("passes the current generation to a verified owner's route", async () => {
    await prepareWrites();
    await setOwner({ state: "pinned", generation: 7, email: OWNER_EMAIL });
    const owner = new Browser();
    await owner.authenticate();
    const response = await owner.post(WRITE_PATH);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ generation: 7 });
    expect((await env.DB.prepare("SELECT * FROM test_writes").all()).results).toEqual([
      { generation: 7, value: "written" },
    ]);
  });

  it.each(["POST", "PUT", "PATCH", "DELETE"])(
    "refuses %s from foreign or missing Origin without any write",
    async (method) => {
      await prepareWrites();
      const owner = new Browser();
      await owner.authenticate();
      const before = await dump();
      const watched = writeRecordingDb();
      for (const origin of [null, "https://evil.example"]) {
        const response = await owner.request(WRITE_PATH, {
          method,
          origin,
          env: testEnv({ DB: watched.db }),
        });
        expect(response.status).toBe(403);
        expect(await dump()).toEqual(before);
        expect(watched.writes).toEqual([]);
      }
      expect(access.requests).toEqual([]);
      expect((await owner.post(WRITE_PATH, {}, { origin: ORIGIN })).status).toBe(200);
    },
  );

  it.each(["missing", "invalid", "another email", "certs unavailable"])(
    "returns the Access refusal for %s instead of running a POST route",
    async (kind) => {
      await prepareWrites();
      const browser = new Browser();
      browser.assertion =
        kind === "missing"
          ? undefined
          : kind === "invalid"
            ? "bad"
            : await signAccessJwt({
                email: kind === "another email" ? "someone.else@example.net" : OWNER_EMAIL,
              });
      if (kind === "certs unavailable") access.mode = "fail";
      const before = await dump();
      const response = await browser.post(WRITE_PATH);
      expect(response.status).toBe(kind === "certs unavailable" ? 503 : 403);
      expect(textOf(await response.text())).toContain(
        kind === "certs unavailable"
          ? ACCESS_UNAVAILABLE.title
          : kind === "another email"
            ? NOT_OWNER.title
            : ACCESS_REFUSED.title,
      );
      expect(await dump()).toEqual(before);
    },
  );

  it("makes a write from a generation returned before a reset change nothing after a new pin", async () => {
    await prepareWrites();
    const owner = new Browser();
    await owner.authenticate();
    const oldResponse = await owner.post(WRITE_PATH);
    expect(oldResponse.status).toBe(200);
    const old = (await oldResponse.json()) as { generation: number };
    const plan = resetPlan(
      { state: "pinned", generation: old.generation, instance: await ownerInstance() },
      Date.now(),
    );
    await env.DB.batch(plan.statements.map((sql) => env.DB.prepare(sql)));
    expect((await owner.get("/accounts")).status).toBe(200);
    expect(await ownerRow()).toMatchObject({ state: "pinned", generation: old.generation + 1 });
    const before = await dump();
    const result = await env.DB.prepare(`INSERT INTO test_writes SELECT ?, 'stale' FROM owner
      WHERE id = 1 AND state = 'pinned' AND generation = ?`)
      .bind(old.generation, old.generation)
      .run();
    expect(result.meta.changes).toBe(0);
    expect(await dump()).toEqual(before);
  });

  it("refuses a pin if a reset starts after the gate's read and before verification completes", async () => {
    const owner = new Browser();
    await owner.authenticate();
    access.mode = "slow";
    const pending = owner.get("/accounts");
    // Wait for the certs request, not an arbitrary time delay.
    const { vi } = await import("vite-plus/test");
    await vi.waitFor(() => expect(access.requests).toHaveLength(1));
    await setOwner({ state: "resetting", generation: 2, email: null });
    const before = await dump();
    access.release();
    const response = await pending;
    expect(response.status).toBe(503);
    expect(textOf(await response.text())).toContain(MISMATCH.title);
    expect(await dump()).toEqual(before);
  });

  it.each([false, true])(
    "refuses an old request after a reset finishes before verification, with the same owner pinned again: %s",
    async (repinned) => {
      await prepareWrites();
      await setOwner({ state: "pinned", generation: 7, email: OWNER_EMAIL });
      const owner = new Browser();
      await owner.authenticate();
      access.mode = "slow";
      const pending = owner.post(WRITE_PATH);
      await vi.waitFor(() => expect(access.requests).toHaveLength(1));

      const plan = resetPlan(
        { state: "pinned", generation: 7, instance: await ownerInstance() },
        Date.now(),
      );
      await env.DB.batch(plan.statements.map((sql) => env.DB.prepare(sql)));
      expect(await ownerRow()).toEqual({ state: "unpinned", generation: 8, email: null });
      if (repinned) {
        access.mode = "ok";
        const currentOwner = new Browser();
        await currentOwner.authenticate();
        expect((await currentOwner.get("/accounts")).status).toBe(200);
        expect(await ownerRow()).toEqual({ state: "pinned", generation: 8, email: OWNER_EMAIL });
      }
      const before = await dump();
      access.release();

      const response = await pending;
      expect(response.status).toBe(503);
      expect(textOf(await response.text())).toContain(MISMATCH.title);
      expect(await dump()).toEqual(before);
      expect((await env.DB.prepare("SELECT * FROM test_writes").all()).results).toEqual([]);
    },
  );
});

it("refuses a pin if another address is pinned after the gate's read and before verification completes", async () => {
  const owner = new Browser();
  await owner.authenticate();
  access.mode = "slow";
  const pending = owner.get("/accounts");
  const { vi } = await import("vite-plus/test");
  await vi.waitFor(() => expect(access.requests).toHaveLength(1));
  await setOwner({ state: "pinned", generation: 1, email: "alex.new@example.com" });
  const before = await dump();
  access.release();
  const response = await pending;
  expect(response.status).toBe(503);
  expect(textOf(await response.text())).toContain(MISMATCH.title);
  expect(await dump()).toEqual(before);
});

it("refuses a reset whose next generation exceeds the safe integer range", () => {
  expect(() =>
    resetPlan({ state: "pinned", generation: Number.MAX_SAFE_INTEGER, instance: 1 }, Date.now()),
  ).toThrow();
});

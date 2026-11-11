import { seedAccount, accounts } from "./support/accounts";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { RESET_CLEANUP, resetOutcome, resetPlan } from "../src/owner/reset";
import { seedConnection, rows } from "./support/connections";
import { Browser } from "./support/browser";
import { MISMATCH } from "./support/copy";
import { dump, ownerInstance, ownerRow, setOwner } from "./support/db";
import { OWNER_EMAIL, testEnv, textOf } from "./support/worker";

const NOW = 1_800_000_000_000;

async function readForPlan() {
  const row = await ownerRow();
  if (row === null) throw new Error("no owner row");
  return { state: row.state, generation: row.generation, instance: await ownerInstance() };
}

/** The reset's statements sent in one call, as `wrangler d1 execute --command` sends them. */
async function runAll(statements: ReadonlyArray<string>) {
  return env.DB.batch(statements.map((sql) => env.DB.prepare(sql)));
}

/** The same statements one at a time, as if remote D1 did not run the call atomically. */
async function runEach(statements: ReadonlyArray<string>) {
  const results = [];
  for (const sql of statements) results.push(await env.DB.prepare(sql).all());
  return results;
}

async function pinnedOwner(generation: number) {
  await setOwner({ state: "pinned", generation, email: OWNER_EMAIL });
}

const unpinnedAt = (generation: number) => ({
  state: "unpinned",
  generation,
  email: null,
});

describe("a reset", () => {
  it("moves a pinned owner through resetting to unpinned at the next generation", async () => {
    await pinnedOwner(3);
    const plan = resetPlan(await readForPlan(), NOW);
    expect(plan.resuming).toBe(false);
    expect(plan.generation).toBe(4);
    expect(plan.statements.length).toBeGreaterThanOrEqual(2 + RESET_CLEANUP.length);

    const [entry] = await runEach(plan.statements.slice(0, 1));
    expect(entry?.results).toHaveLength(1);
    expect(await ownerRow()).toMatchObject({ state: "resetting", generation: 4 });
    const results = [entry!, ...(await runAll(plan.statements.slice(1)))];

    expect(await ownerRow()).toEqual(unpinnedAt(4));
    expect(resetOutcome(plan, results)).toBe("done");
  });

  it("runs as a deliberate reset on an unpinned row", async () => {
    const plan = resetPlan(await readForPlan(), NOW);
    expect(plan.generation).toBe(2);
    const results = await runAll(plan.statements);
    expect(await ownerRow()).toEqual(unpinnedAt(2));
    expect(resetOutcome(plan, results)).toBe("done");
  });

  it("makes every request answer as during a mismatch while it runs, whatever OWNER_EMAIL is", async () => {
    await pinnedOwner(1);
    const owner = new Browser();
    await owner.authenticate();
    const plan = resetPlan(await readForPlan(), NOW);
    await runEach(plan.statements.slice(0, 1));
    expect(await ownerRow()).toMatchObject({ state: "resetting" });
    const before = await dump();

    for (const ownerEmail of [OWNER_EMAIL, "alex.new@example.com"]) {
      const workerEnv = testEnv({ OWNER_EMAIL: ownerEmail });
      for (const response of [
        await owner.get("/accounts", { env: workerEnv }),
        await owner.get("/connections", { env: workerEnv }),
        await owner.post("/accounts", {}, { env: workerEnv }),
        await owner.post("/connections", {}, { env: workerEnv }),
      ]) {
        expect(response.status).toBe(503);
        expect(textOf(await response.text())).toContain(MISMATCH.title);
      }
      expect((await owner.get("/mcp", { env: workerEnv })).status).toBe(503);
    }
    expect(await dump()).toEqual(before);
  });
});

describe("a reset that is interrupted, repeated, raced, or delayed", () => {
  it("finishes when run again after stopping at any point", async () => {
    await pinnedOwner(5);
    const fresh = resetPlan(await readForPlan(), NOW);

    for (let applied = 1; applied < fresh.statements.length; applied++) {
      await setOwner({ state: "pinned", generation: 5, email: OWNER_EMAIL });
      await pinnedOwner(5);
      await runEach(fresh.statements.slice(0, applied));
      expect(await ownerRow(), `stopped after ${applied}`).toMatchObject({
        state: "resetting",
        generation: 6,
      });

      const resumed = resetPlan(await readForPlan(), NOW);
      expect(resumed.resuming).toBe(true);
      expect(resumed.generation).toBe(6);
      const results = await runAll(resumed.statements);

      expect(await ownerRow(), `stopped after ${applied}`).toEqual(unpinnedAt(6));
      expect(resetOutcome(resumed, results), `stopped after ${applied}`).toBe("done");
    }
  });

  it("does not report Done when someone else finished the reset it resumed", async () => {
    await pinnedOwner(2);
    await runEach(resetPlan(await readForPlan(), NOW).statements.slice(0, 1));
    const mine = resetPlan(await readForPlan(), NOW);
    const theirs = resetPlan(await readForPlan(), NOW);
    await runAll(theirs.statements);
    const finished = await dump();

    const results = await runAll(mine.statements);

    expect(await dump()).toEqual(finished);
    expect(resetOutcome(mine, results)).not.toBe("done");
  });

  it("lets only one of two runs that read the same generation perform the reset", async () => {
    await pinnedOwner(1);
    const row = await readForPlan();
    const first = resetPlan(row, NOW);
    const second = resetPlan(row, NOW);

    expect(resetOutcome(first, await runAll(first.statements))).toBe("done");
    const afterFirst = await dump();
    const secondResults = await runAll(second.statements);

    expect(secondResults[0]?.results).toEqual([]);
    expect(resetOutcome(second, secondResults)).toBe("overtaken");
    expect(await dump()).toEqual(afterFirst);
  });

  it("changes nothing when it arrives after another reset finished and a new owner signed in", async () => {
    await pinnedOwner(1);
    const delayed = resetPlan(await readForPlan(), NOW);
    await runAll(resetPlan(await readForPlan(), NOW).statements);
    const newOwner = new Browser();
    await newOwner.authenticate();
    expect((await newOwner.get("/accounts")).status).toBe(200);
    expect(await ownerRow()).toMatchObject({
      state: "pinned",
      generation: 2,
    });
    const before = await dump();

    for (const run of [runAll, runEach]) {
      const results = await run(delayed.statements);
      expect(resetOutcome(delayed, results)).toBe("overtaken");
      expect(await dump()).toEqual(before);
    }
    expect((await newOwner.get("/accounts")).status).toBe(200);
  });

  it("never touches a newer reset with its cleanup or finishing statements", async () => {
    await pinnedOwner(1);
    const old = resetPlan(await readForPlan(), NOW);
    await runEach(old.statements.slice(0, 1));
    // Someone else finishes that reset, a new owner signs in at generation 2, and a newer reset begins.
    await runAll(resetPlan(await readForPlan(), NOW).statements);
    const newOwner = new Browser();
    await newOwner.authenticate();
    expect((await newOwner.get("/accounts")).status).toBe(200);
    const newer = resetPlan(await readForPlan(), NOW);
    await runEach(newer.statements.slice(0, 1));
    expect(await ownerRow()).toMatchObject({ state: "resetting", generation: 3 });
    const before = await dump();

    await runEach(old.statements.slice(1));

    expect(await dump()).toEqual(before);
  });

  it("changes nothing in a database other than the one it read", async () => {
    await pinnedOwner(2);
    const row = await readForPlan();
    const before = await dump();

    const elsewhere = resetPlan(
      { ...row, instance: row.instance === 1 ? 2 : row.instance - 1 },
      NOW,
    );
    const results = await runEach(elsewhere.statements);

    expect(resetOutcome(elsewhere, results)).toBe("overtaken");
    expect(await dump()).toEqual(before);

    await runEach(resetPlan(row, NOW).statements.slice(0, 1));
    const resetting = await dump();
    const resumedElsewhere = resetPlan(
      { ...(await readForPlan()), instance: row.instance === 1 ? 2 : row.instance - 1 },
      NOW,
    );
    await runEach(resumedElsewhere.statements);
    expect(await dump()).toEqual(resetting);
  });

  it("refuses an instance that is not a positive safe integer", () => {
    for (const instance of [Number.NaN, 0, -3, 2.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(
        () => resetPlan({ state: "pinned", generation: 1, instance }, NOW),
        String(instance),
      ).toThrow();
    }
  });

  it("deletes connections, accounts, permissions, calls and approvals with exactly this reset's guard", () => {
    const guard =
      "EXISTS (SELECT 1 FROM owner WHERE id = 1 AND state = 'resetting' AND generation = 7)";
    const cleanup = RESET_CLEANUP.map((statement) => statement({ guard, now: NOW }));
    expect(cleanup).toHaveLength(5);
    expect(cleanup).toEqual(
      expect.arrayContaining([
        `DELETE FROM connections WHERE ${guard}`,
        `DELETE FROM accounts WHERE ${guard}`,
        `DELETE FROM permissions WHERE ${guard}`,
        `DELETE FROM calls WHERE ${guard}`,
        `DELETE FROM approvals WHERE ${guard}`,
      ]),
    );
  });

  it("refuses a generation that is not a safe integer", () => {
    for (const generation of [Number.NaN, 1.5, Number.MAX_SAFE_INTEGER + 1, -1, 0]) {
      expect(
        () => resetPlan({ state: "pinned", generation, instance: 1 }, NOW),
        String(generation),
      ).toThrow();
    }
    expect(() => resetPlan({ state: "pinned", generation: 1, instance: 1 }, Number.NaN)).toThrow();
  });
});

describe("two owner requests racing to pin", () => {
  it("opens both requests and pins the email once at the current generation", async () => {
    const browser = new Browser();
    await browser.authenticate();
    const responses = await Promise.all([browser.get("/accounts"), browser.get("/connections")]);
    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    expect(await ownerRow()).toEqual({ state: "pinned", generation: 1, email: OWNER_EMAIL });
    expect(responses.flatMap((r) => r.headers.getSetCookie())).toEqual([]);
  });
});

it("deletes every connection while resetting and leaves another database or newer generation intact", async () => {
  await pinnedOwner(2);
  await seedConnection({ generation: 1 });
  await seedConnection({ generation: 2, state: "revoked", revoked_at: NOW });
  const row = await readForPlan();
  const wrongDatabase = resetPlan(
    { ...row, instance: row.instance === 1 ? 2 : row.instance - 1 },
    NOW,
  );
  const before = await dump();
  await runEach(wrongDatabase.statements);
  expect(await dump()).toEqual(before);
  const plan = resetPlan(row, NOW);
  await runEach(plan.statements.slice(0, 1));
  expect(await rows()).toHaveLength(2);
  await runEach(plan.statements.slice(1));
  expect(await rows()).toEqual([]);
  await pinnedOwner(3);
  await seedConnection({ generation: 3 });
  const repinned = await dump();
  await runEach(plan.statements.slice(1));
  expect(await dump()).toEqual(repinned);
});

it("continues connection cleanup after an interrupted reset", async () => {
  await pinnedOwner(1);
  await seedConnection();
  const plan = resetPlan(await readForPlan(), NOW);
  await runEach(plan.statements.slice(0, 1));
  const resumed = resetPlan(await readForPlan(), NOW);
  expect(resumed.resuming).toBe(true);
  await runAll(resumed.statements);
  expect(await rows()).toEqual([]);
  expect(await ownerRow()).toEqual(unpinnedAt(2));
});

it("deletes live and removed accounts only under the confirmed reset guard", async () => {
  await pinnedOwner(1);
  await seedAccount();
  await seedAccount({ state: "removed", refresh_token: null, access_token: null });
  const row = await readForPlan();
  const before = await dump();
  await runAll(
    resetPlan({ ...row, instance: row.instance === 1 ? 2 : row.instance - 1 }, NOW).statements,
  );
  expect(await dump()).toEqual(before);
  await runAll(resetPlan(row, NOW).statements);
  expect(await accounts()).toEqual([]);
});

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { RESET_CLEANUP, resetOutcome, resetPlan } from "../src/owner/reset";
import { Browser } from "./support/browser";
import { DIDNT_FINISH, MISMATCH, NOT_OWNER } from "./support/copy";
import { dump, insertSession, ownerRow, sessions, setOwner, sha256Hex } from "./support/db";
import { location, OWNER_EMAIL, testEnv, textOf } from "./support/worker";

const NOW = 1_800_000_000_000;

async function readForPlan() {
  const row = await ownerRow();
  if (row === null) throw new Error("no owner row");
  return { state: row.state, generation: row.generation };
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

async function pinnedOwnerWithSessions(generation: number) {
  await setOwner({ state: "pinned", generation, email: OWNER_EMAIL, google_sub: "sub-a" });
  for (const name of ["phone", "laptop"]) {
    await insertSession({
      token_hash: await sha256Hex(name),
      generation,
      created_at: NOW,
      last_used_at: NOW,
    });
  }
}

const unpinnedAt = (generation: number) => ({
  state: "unpinned",
  generation,
  email: null,
  google_sub: null,
});

describe("a reset", () => {
  it("moves a pinned owner through resetting to unpinned at the next generation and ends every session", async () => {
    await pinnedOwnerWithSessions(3);
    const plan = resetPlan(await readForPlan(), NOW);
    expect(plan.resuming).toBe(false);
    expect(plan.generation).toBe(4);
    expect(plan.statements.length).toBeGreaterThanOrEqual(2 + RESET_CLEANUP.length);

    const [entry] = await runEach(plan.statements.slice(0, 1));
    expect(entry?.results).toHaveLength(1);
    expect(await ownerRow()).toMatchObject({ state: "resetting", generation: 4 });
    const results = [entry!, ...(await runAll(plan.statements.slice(1)))];

    expect(await ownerRow()).toEqual(unpinnedAt(4));
    expect(await sessions()).toEqual([]);
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
    await pinnedOwnerWithSessions(1);
    const owner = new Browser();
    await owner.signInAsOwner();
    const plan = resetPlan(await readForPlan(), NOW);
    await runEach(plan.statements.slice(0, 1));
    expect(await ownerRow()).toMatchObject({ state: "resetting" });
    const before = await dump();

    for (const ownerEmail of [OWNER_EMAIL, "alex.new@example.com"]) {
      const workerEnv = testEnv({ OWNER_EMAIL: ownerEmail });
      for (const response of [
        await owner.get("/accounts", { env: workerEnv }),
        await owner.get("/signin", { env: workerEnv }),
        await owner.post("/signin", {}, { env: workerEnv }),
        await owner.post("/signout", {}, { env: workerEnv }),
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
    await pinnedOwnerWithSessions(5);
    const fresh = resetPlan(await readForPlan(), NOW);

    for (let applied = 1; applied < fresh.statements.length; applied++) {
      await setOwner({ state: "pinned", generation: 5, email: OWNER_EMAIL, google_sub: "sub-a" });
      await env.DB.prepare("DELETE FROM owner_sessions").run();
      await pinnedOwnerWithSessions(5);
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
      expect(await sessions(), `stopped after ${applied}`).toEqual([]);
      expect(resetOutcome(resumed, results), `stopped after ${applied}`).toBe("done");
    }
  });

  it("does not report Done when someone else finished the reset it resumed", async () => {
    await pinnedOwnerWithSessions(2);
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
    await pinnedOwnerWithSessions(1);
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
    await pinnedOwnerWithSessions(1);
    const delayed = resetPlan(await readForPlan(), NOW);
    await runAll(resetPlan(await readForPlan(), NOW).statements);
    const newOwner = new Browser();
    await newOwner.signInAsOwner({ sub: "sub-new" });
    expect(await ownerRow()).toMatchObject({
      state: "pinned",
      generation: 2,
      google_sub: "sub-new",
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
    await pinnedOwnerWithSessions(1);
    const old = resetPlan(await readForPlan(), NOW);
    await runEach(old.statements.slice(0, 1));
    // Someone else finishes that reset, a new owner signs in at generation 2, and a newer reset begins.
    await runAll(resetPlan(await readForPlan(), NOW).statements);
    const newOwner = new Browser();
    await newOwner.signInAsOwner({ sub: "sub-new" });
    const newer = resetPlan(await readForPlan(), NOW);
    await runEach(newer.statements.slice(0, 1));
    expect(await ownerRow()).toMatchObject({ state: "resetting", generation: 3 });
    const before = await dump();

    await runEach(old.statements.slice(1));

    expect(await dump()).toEqual(before);
  });

  it("guards every cleanup statement on this reset's generation", () => {
    const guard =
      "EXISTS (SELECT 1 FROM owner WHERE id = 1 AND state = 'resetting' AND generation = 7)";
    expect(RESET_CLEANUP.length).toBeGreaterThan(0);
    for (const cleanup of RESET_CLEANUP) {
      expect(cleanup({ guard, now: NOW })).toContain(guard);
    }
  });

  it("refuses a generation that is not a safe integer", () => {
    for (const generation of [Number.NaN, 1.5, Number.MAX_SAFE_INTEGER + 1, -1, 0]) {
      expect(() => resetPlan({ state: "pinned", generation }, NOW), String(generation)).toThrow();
    }
    expect(() => resetPlan({ state: "pinned", generation: 1 }, Number.NaN)).toThrow();
  });
});

describe("two sign-ins that race to pin an unpinned owner", () => {
  it("pin exactly one Google account when they come from different accounts", async () => {
    const a = new Browser();
    const b = new Browser();
    const [startA, startB] = [await a.startSignIn(), await b.startSignIn()];

    const [responseA, responseB] = await Promise.all([
      a.finishSignIn(startA, { sub: "sub-a" }),
      b.finishSignIn(startB, { sub: "sub-b" }),
    ]);

    const winners = [responseA, responseB].filter((r) => r.status === 302);
    const losers = [responseA, responseB].filter((r) => r.status === 403);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(textOf(await losers[0]!.text())).toContain(NOT_OWNER.title);
    const row = await ownerRow();
    const winner = responseA.status === 302 ? a : b;
    const loser = winner === a ? b : a;
    expect(row).toMatchObject({
      state: "pinned",
      generation: 1,
      google_sub: winner === a ? "sub-a" : "sub-b",
    });
    expect(winner.session).toBeDefined();
    expect(loser.session).toBeUndefined();
    expect(await sessions()).toHaveLength(1);
  });

  it("give both tabs a session when they are the same Google account", async () => {
    const browser = new Browser();
    const [first, second] = [
      await browser.startSignIn("/accounts"),
      await browser.startSignIn("/connections"),
    ];
    expect(first.state).not.toBe(second.state);

    const responses = await Promise.all([
      browser.finishSignIn(first),
      browser.finishSignIn(second),
    ]);

    expect(responses.map((r) => r.status)).toEqual([302, 302]);
    expect(responses.map(location).sort((x, y) => String(x).localeCompare(String(y)))).toEqual([
      "/accounts",
      "/connections",
    ]);
    expect(await ownerRow()).toEqual({
      state: "pinned",
      generation: 1,
      email: OWNER_EMAIL,
      google_sub: "sub-a",
    });
    expect(await sessions()).toHaveLength(2);
  });
});

describe("data from before a reset", () => {
  it("does not open owner pages with a session from an earlier generation", async () => {
    await setOwner({ state: "pinned", generation: 2, email: OWNER_EMAIL, google_sub: "sub-a" });
    const token = "B".repeat(43);
    await insertSession({
      token_hash: await sha256Hex(token),
      generation: 1,
      created_at: Date.now(),
      last_used_at: Date.now(),
    });
    const browser = new Browser();
    browser.cookies.set("__Host-session", token);

    const response = await browser.get("/accounts");

    expect(response.status).toBe(302);
    expect(location(response)).toBe("/signin?next=%2Faccounts");
  });

  it("stores nothing for a sign-in begun before the reset and finished after it", async () => {
    await pinnedOwnerWithSessions(1);
    const browser = new Browser();
    const before = await browser.startSignIn();
    await runAll(resetPlan(await readForPlan(), NOW).statements);
    const afterReset = await dump();

    const response = await browser.finishSignIn(before);

    expect(response.status).toBe(400);
    expect(textOf(await response.text())).toContain(DIDNT_FINISH.title);
    expect(browser.session).toBeUndefined();
    expect(await dump()).toEqual(afterReset);
  });

  it("stores nothing for it even after the same owner signs in again in the same browser", async () => {
    await pinnedOwnerWithSessions(1);
    const browser = new Browser();
    const old = await browser.startSignIn();
    await runAll(resetPlan(await readForPlan(), NOW).statements);
    await browser.signInAsOwner();
    expect(await ownerRow()).toMatchObject({ state: "pinned", generation: 2 });
    const session = browser.session;
    const afterSignIn = await dump();

    const response = await browser.finishSignIn(old);

    expect(response.status).toBe(400);
    expect(textOf(await response.text())).toContain(DIDNT_FINISH.title);
    expect(browser.session).toBe(session);
    expect(await dump()).toEqual(afterSignIn);
  });
});

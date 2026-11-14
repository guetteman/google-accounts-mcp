import { seedAccount } from "./support/accounts";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { resetOutcome, resetPlan } from "../src/owner/reset";
import { seedConnection } from "./support/connections";
import { Browser } from "./support/browser";
import { dump, ownerRow, setOwner } from "./support/db";
import { OWNER_EMAIL } from "./support/worker";

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
    const plan = resetPlan(await readForPlan());
    expect(plan.resuming).toBe(false);
    expect(plan.generation).toBe(4);

    const [entry] = await runEach(plan.statements.slice(0, 1));
    expect(entry?.results).toHaveLength(1);
    expect(await ownerRow()).toMatchObject({ state: "resetting", generation: 4 });
    const results = [entry!, ...(await runAll(plan.statements.slice(1)))];

    expect(await ownerRow()).toEqual(unpinnedAt(4));
    expect(resetOutcome(plan, results)).toBe("done");
  });

  it("runs as a deliberate reset on an unpinned row", async () => {
    const plan = resetPlan(await readForPlan());
    expect(plan.generation).toBe(2);
    const results = await runAll(plan.statements);
    expect(await ownerRow()).toEqual(unpinnedAt(2));
    expect(resetOutcome(plan, results)).toBe("done");
  });
});

describe("a reset that is interrupted, repeated, raced, or delayed", () => {
  it("finishes when run again after stopping at any point", async () => {
    await pinnedOwner(5);
    const fresh = resetPlan(await readForPlan());

    for (let applied = 1; applied < fresh.statements.length; applied++) {
      await setOwner({ state: "pinned", generation: 5, email: OWNER_EMAIL });
      await pinnedOwner(5);
      await runEach(fresh.statements.slice(0, applied));
      expect(await ownerRow(), `stopped after ${applied}`).toMatchObject({
        state: "resetting",
        generation: 6,
      });

      const resumed = resetPlan(await readForPlan());
      expect(resumed.resuming).toBe(true);
      expect(resumed.generation).toBe(6);
      const results = await runAll(resumed.statements);

      expect(await ownerRow(), `stopped after ${applied}`).toEqual(unpinnedAt(6));
      expect(resetOutcome(resumed, results), `stopped after ${applied}`).toBe("done");
    }
  });

  it("does not report Done when someone else finished the reset it resumed", async () => {
    await pinnedOwner(2);
    await runEach(resetPlan(await readForPlan()).statements.slice(0, 1));
    const mine = resetPlan(await readForPlan());
    const theirs = resetPlan(await readForPlan());
    await runAll(theirs.statements);
    const finished = await dump();

    const results = await runAll(mine.statements);

    expect(await dump()).toEqual(finished);
    expect(resetOutcome(mine, results)).not.toBe("done");
  });

  it("lets only one of two runs that read the same generation perform the reset", async () => {
    await pinnedOwner(1);
    const row = await readForPlan();
    const first = resetPlan(row);
    const second = resetPlan(row);

    expect(resetOutcome(first, await runAll(first.statements))).toBe("done");
    const afterFirst = await dump();
    const secondResults = await runAll(second.statements);

    expect(secondResults[0]?.results).toEqual([]);
    expect(resetOutcome(second, secondResults)).toBe("overtaken");
    expect(await dump()).toEqual(afterFirst);
  });

  it("keeps an owner who signed in after the reset read an unpinned row", async () => {
    const plan = resetPlan(await readForPlan());
    const owner = new Browser();
    await owner.authenticate();
    expect((await owner.get("/accounts")).status).toBe(200);
    expect(await ownerRow()).toMatchObject({ state: "pinned", generation: 1 });
    const before = await dump();

    expect(resetOutcome(plan, await runAll(plan.statements))).toBe("overtaken");
    expect(await dump()).toEqual(before);
  });

  it("changes nothing when it arrives after another reset finished and a new owner signed in", async () => {
    await pinnedOwner(1);
    const delayed = resetPlan(await readForPlan());
    await runAll(resetPlan(await readForPlan()).statements);
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
    const old = resetPlan(await readForPlan());
    await runEach(old.statements.slice(0, 1));
    // Someone else finishes that reset, a new owner signs in at generation 2, and a newer reset begins.
    await runAll(resetPlan(await readForPlan()).statements);
    const newOwner = new Browser();
    await newOwner.authenticate();
    expect((await newOwner.get("/accounts")).status).toBe(200);
    const newer = resetPlan(await readForPlan());
    await runEach(newer.statements.slice(0, 1));
    expect(await ownerRow()).toMatchObject({ state: "resetting", generation: 3 });
    const before = await dump();

    await runEach(old.statements.slice(1));

    expect(await dump()).toEqual(before);
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

const OWNER_TABLES = [
  "connections",
  "accounts",
  "permissions",
  "calls",
  "call_accounts",
  "approvals",
  "once",
  "uploads",
];
const tableRows = async (table: string) =>
  (await env.DB.prepare(`SELECT * FROM ${table}`).all()).results;

it("deletes the previous owner's rows only under its own state and generation", async () => {
  await pinnedOwner(2);
  await seedConnection({ generation: 1 });
  await seedConnection({ generation: 2, state: "revoked", revoked_at: NOW });
  const account = await seedAccount();
  await seedAccount({ state: "removed", refresh_token: null, access_token: null });
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO permissions (connection_id,account_id,tool,ask) VALUES ('reset-connection',?1,'read_thread',1)",
    ).bind(account.id),
    env.DB.prepare(
      "INSERT INTO calls (id,connection_id,account_id,tool,at) VALUES (1,'reset-connection',?1,'read_thread',?2)",
    ).bind(account.id, NOW),
    env.DB.prepare(
      "INSERT INTO approvals (id,generation,connection_id,call_id,tool,uses,created_at,expires_at,state,arguments) VALUES ('reset-approval',2,'reset-connection',1,'read_thread','[]',?1,?2,'waiting','sealed-arguments')",
    ).bind(NOW, NOW + 1000),
    env.DB.prepare(
      "INSERT INTO once (identity,state,claim,taken_at,expires_at) VALUES ('test-identity','unknown','test-claim',?1,?2)",
    ).bind(NOW, NOW + 1000),
    env.DB.prepare(
      "INSERT INTO uploads (id,link,generation,connection_id,expires_at,file) VALUES ('reset-upload','reset-link',2,'reset-connection',?1,'sealed-reference')",
    ).bind(NOW + 1000),
  ]);
  for (const table of OWNER_TABLES) expect(await tableRows(table), table).not.toEqual([]);

  // The first run stops right after it begins.
  const plan = resetPlan(await readForPlan());
  await runEach(plan.statements.slice(0, 1));

  const resumed = resetPlan(await readForPlan());
  expect(resumed.resuming).toBe(true);
  await runAll(resumed.statements);
  for (const table of OWNER_TABLES) expect(await tableRows(table), table).toEqual([]);
  expect(await ownerRow()).toEqual(unpinnedAt(3));

  // The first run's cleanup arrives late: after a new owner pinned, and during a newer reset.
  await pinnedOwner(3);
  await seedConnection({ generation: 3 });
  const repinned = await dump();
  await runEach(plan.statements.slice(1));
  expect(await dump()).toEqual(repinned);
  await runEach(resetPlan(await readForPlan()).statements.slice(0, 1));
  const newer = await dump();
  await runEach(plan.statements.slice(1));
  expect(await dump()).toEqual(newer);
});

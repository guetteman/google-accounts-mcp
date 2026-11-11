import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { Effect } from "effect";
import { expect, it, vi } from "vite-plus/test";
import "./support/account-checks";
import worker from "../src/index";
import { TOOLS, type Tool } from "../src/mcp/tools";
import { NOW } from "./support/accounts";
import { observeStatements, statementFailingDb } from "./support/db";
import { google, deferred, LABELS_RESPONSE } from "./support/google";
import { callRows, fixture } from "./support/permissions";
import { ask, approve, decided, digest, get, post, row, setting } from "./support/approvals";
import { ORIGIN, testEnv } from "./support/worker";
const tool = TOOLS.find((tool) => tool.kind === "account")!;
if (tool.kind !== "account") throw new Error("Missing account tool");

it("requires a view on every account tool at compile time", () => {
  type Account = Extract<Tool, { kind: "account" }>;
  type ViewIsRequired = Omit<Account, "view"> extends Account ? false : true;
  const required: ViewIsRequired = true;
  expect(required).toBe(true);
});
it("passes the stored schema-decoded arguments to both the view and the run", async () => {
  const f = await fixture();
  await setting(f, "ask");
  const args = { account: " Alex.Personal@Example.com " };
  const id = await ask(f, { ...args, ignored: "discard me" });
  const values = vi.spyOn(tool.view, "values");
  const run = vi.spyOn(tool, "run");
  await approve(f, id);
  expect(values.mock.calls.length).toBeGreaterThan(0);
  for (const [argument] of values.mock.calls) expect(argument).toEqual(args);
  expect(run).toHaveBeenCalledTimes(1);
  expect(run.mock.calls[0]![2]).toEqual(args);
});
it("keeps the existing 401 retry inside one approved execution", async () => {
  const f = await fixture();
  await setting(f, "ask");
  const id = await ask(f);
  const run = vi.spyOn(tool, "run");
  google.labelAnswers.push(() => new Response(null, { status: 401 }));
  expect((await approve(f, id)).state.kind).toBe("succeeded");
  expect(run).toHaveBeenCalledTimes(1);
  expect(google.labelRequests).toHaveLength(2);
  expect(google.refreshTokens).toHaveLength(1);
});
it("keeps the whole Approve work in waitUntil after the owner's request disconnects", async () => {
  const f = await fixture();
  await setting(f, "ask");
  const id = await ask(f);
  const d = await digest(f, id);
  const entered = deferred(),
    release = deferred();
  google.labelAnswers.push(async () => {
    entered.resolve();
    await release.promise;
    return Response.json(LABELS_RESPONSE);
  });
  const execution = createExecutionContext();
  const waitUntil = vi.spyOn(execution, "waitUntil");
  const controller = new AbortController();
  const response = worker.fetch(
    new Request(`${ORIGIN}/approvals/${id}/approve`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Origin: ORIGIN,
        "Cf-Access-Jwt-Assertion": f.mcp.browser.assertion!,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ digest: d }),
    }),
    testEnv(),
    execution,
  );
  await entered.promise;
  expect(waitUntil).toHaveBeenCalled();
  expect(waitUntil.mock.calls.some(([promise]) => promise instanceof Promise)).toBe(true);
  controller.abort();
  release.resolve();
  await waitOnExecutionContext(execution);
  expect((await decided(await response)).state.kind).toBe("succeeded");
  expect(await row(id)).toMatchObject({ outcome: "success" });
  expect((await callRows())[0]!.outcome).toBe("success");
});
it("answers unknown at the absolute deadline while refresh persistence is held and starts no Gmail request afterwards", async () => {
  const f = await fixture({ access_expires_at: NOW });
  await setting(f, "ask");
  const id = await ask(f);
  const d = await digest(f, id);
  const entered = deferred(),
    release = deferred(),
    refreshed = deferred();
  const db = observeStatements(
    env.DB,
    async (sql) => {
      if (/UPDATE accounts AS a SET access_token/.test(sql)) {
        entered.resolve();
        await release.promise;
      }
    },
    (sql) => {
      if (/UPDATE accounts AS a SET access_token/.test(sql)) refreshed.resolve();
    },
  );
  const fetches = vi.spyOn(globalThis, "fetch");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let finished = false;
  const running = post(f, id, "approve", { digest: d }, testEnv({ DB: db })).then((response) => {
    finished = true;
    return response;
  });
  await entered.promise;
  await vi.advanceTimersByTimeAsync(24_999);
  expect(finished).toBe(false);
  vi.spyOn(Date, "now").mockReturnValue(NOW + 25_000);
  await vi.advanceTimersByTimeAsync(1);
  expect((await decided(await running)).state.kind).toBe("unknown");
  expect((await callRows())[0]!.outcome).toBeNull();
  expect(await get(f, id)).toEqual({ status: "unknown" });
  release.resolve();
  await refreshed.promise;
  // A completed token write would ordinarily be followed by Gmail; drain that continuation.
  await vi.advanceTimersByTimeAsync(1);
  expect(google.labelRequests).toEqual([]);
  expect(
    fetches.mock.calls
      .map(([input]) => (input instanceof Request ? input.url : String(input)))
      .filter((url) => url.includes("gmail.googleapis.com")),
  ).toEqual([]);
});
it("subtracts view time from each Gmail attempt's ten-second budget", async () => {
  const f = await fixture();
  await setting(f, "ask");
  const id = await ask(f);
  const d = await digest(f, id);
  const entered = deferred();
  vi.spyOn(tool.view, "values").mockImplementation(() => {
    vi.spyOn(Date, "now").mockReturnValue(NOW + 23_000);
    return Effect.succeed([]);
  });
  let aborted = false;
  google.labelAnswers.push((request) => {
    entered.resolve();
    return new Promise<Response>((_resolve, reject) => {
      request.signal.addEventListener("abort", () => {
        aborted = true;
        reject(new Error("aborted"));
      });
    });
  });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const running = post(f, id, "approve", { digest: d });
  await entered.promise;
  expect((await row(id))!.decided_at).toBe(NOW);
  await vi.advanceTimersByTimeAsync(1999);
  expect(aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect((await decided(await running)).state.kind).toBe("unknown");
  expect(aborted).toBe(true);
  expect((await callRows())[0]!.outcome).toBeNull();
});
it("does not execute when a view finishes beyond the request deadline", async () => {
  const f = await fixture();
  await setting(f, "ask");
  const id = await ask(f);
  const d = await digest(f, id);
  vi.spyOn(tool.view, "values").mockImplementation(() => {
    vi.spyOn(Date, "now").mockReturnValue(NOW + 25_000);
    return Effect.succeed([]);
  });
  const response = await post(f, id, "approve", { digest: d });
  expect(response.status).toBe(503);
  expect(await row(id)).toMatchObject({ state: "waiting" });
  expect(google.labelRequests).toEqual([]);
});
it("does not execute when the decision response arrives after the request deadline", async () => {
  const run = vi.spyOn(tool, "run");
  const f = await fixture();
  await setting(f, "ask");
  const id = await ask(f);
  const d = await digest(f, id);
  const db = observeStatements(
    env.DB,
    () => {},
    (sql) => {
      if (/UPDATE approvals SET state = 'approved'/.test(sql))
        vi.spyOn(Date, "now").mockReturnValue(NOW + 25_000);
    },
  );
  expect(
    (await decided(await post(f, id, "approve", { digest: d }, testEnv({ DB: db })))).state.kind,
  ).toBe("unknown");
  expect(google.labelRequests).toEqual([]);
  expect(run).not.toHaveBeenCalled();
  expect((await callRows())[0]!.outcome).toBeNull();
});
it("leaves a server failure during execution unknown with no pending audit outcome", async () => {
  const f = await fixture({ access_expires_at: NOW });
  await setting(f, "ask");
  const id = await ask(f);
  const db = statementFailingDb(/UPDATE accounts AS a SET access_token/);
  expect((await approve(f, id, testEnv({ DB: db }))).state.kind).toBe("unknown");
  expect((await callRows())[0]!.outcome).toBeNull();
  expect(await get(f, id)).toEqual({ status: "unknown" });
});
it("leaves the outcome unsettled when its persistence fails and later settles unknown", async () => {
  const f = await fixture();
  await setting(f, "ask");
  const id = await ask(f);
  const db = statementFailingDb(/UPDATE approvals SET outcome = \?5/);
  expect(
    (await post(f, id, "approve", { digest: await digest(f, id) }, testEnv({ DB: db }))).status,
  ).toBe(503);
  expect((await callRows())[0]!.outcome).toBeNull();
  expect(await row(id)).toMatchObject({ outcome: null, arguments: null });
  vi.spyOn(Date, "now").mockReturnValue(NOW + 30_000);
  expect(await get(f, id)).toEqual({ status: "unknown" });
});

it("does not let a stalled loser's deadline finish the winner's running call", async () => {
  const f = await fixture();
  await setting(f, "ask");
  const id = await ask(f);
  const d = await digest(f, id);
  const stalled = deferred(),
    resume = deferred(),
    entered = deferred(),
    release = deferred();
  let held = false;
  const writes: string[] = [];
  const db = observeStatements(env.DB, async (sql) => {
    if (/UPDATE approvals SET outcome = \?5/.test(sql)) writes.push(sql);
    if (!held && sql.startsWith("UPDATE calls") && sql.includes("'expired'")) {
      held = true;
      stalled.resolve();
      await resume.promise;
    }
  });
  google.labelAnswers.push(async () => {
    entered.resolve();
    await release.promise;
    return Response.json(LABELS_RESPONSE);
  });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const loser = post(f, id, "approve", { digest: d }, testEnv({ DB: db }));
  await stalled.promise;
  vi.spyOn(Date, "now").mockReturnValue(NOW + 20_000);
  await vi.advanceTimersByTimeAsync(20_000);
  const winner = post(f, id, "approve", { digest: d });
  await entered.promise;
  try {
    vi.spyOn(Date, "now").mockReturnValue(NOW + 25_000);
    await vi.advanceTimersByTimeAsync(5000);
    expect((await loser).status).toBe(503);
    expect(writes).toEqual([]);
    expect((await row(id))!.outcome).toBeNull();
  } finally {
    resume.resolve();
    release.resolve();
  }
  expect((await decided(await winner)).state.kind).toBe("succeeded");
  expect((await row(id))!.result).not.toBeNull();
  expect((await callRows())[0]!.outcome).toBe("success");
  expect(await get(f, id)).toHaveProperty("result.labels");
});

it("uses arrival plus twenty-five seconds even when reading the form consumes twenty-three seconds", async () => {
  const f = await fixture();
  await setting(f, "ask");
  const id = await ask(f);
  const d = await digest(f, id);
  const formData = Reflect.get(Request.prototype, "formData") as (
    this: Request,
  ) => Promise<FormData>;
  vi.spyOn(Request.prototype, "formData").mockImplementationOnce(async function (this: Request) {
    const result = await formData.call(this);
    vi.spyOn(Date, "now").mockReturnValue(NOW + 23_000);
    return result;
  });
  const entered = deferred(),
    release = deferred();
  let held = false;
  const db = observeStatements(env.DB, async (sql) => {
    if (!held && sql.startsWith("UPDATE calls") && sql.includes("'expired'")) {
      held = true;
      entered.resolve();
      await release.promise;
    }
  });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let finished = false;
  const response = post(f, id, "approve", { digest: d }, testEnv({ DB: db })).then((r) => {
    finished = true;
    return r;
  });
  await entered.promise;
  try {
    vi.spyOn(Date, "now").mockReturnValue(NOW + 24_999);
    await vi.advanceTimersByTimeAsync(1999);
    expect(finished).toBe(false);
    vi.spyOn(Date, "now").mockReturnValue(NOW + 25_000);
    await vi.advanceTimersByTimeAsync(1);
    expect(finished).toBe(true);
    expect((await response).status).toBe(503);
  } finally {
    release.resolve();
  }
  await vi.advanceTimersByTimeAsync(1);
  expect(google.labelRequests).toEqual([]);
  expect((await row(id))!.state).toBe("waiting");
});

it("gives credentials only to the winner when both requests reach the decision batch together", async () => {
  const f = await fixture();
  await setting(f, "ask");
  const id = await ask(f);
  const d = await digest(f, id);
  const together = deferred(),
    release = deferred();
  let arrivals = 0;
  // Capture all decision results, including the losing batch's empty credential selection.
  const store = await import("../src/approvals/store");
  const original = store.decideApproval;
  const decisions: { won: boolean; credentials: unknown[] }[] = [];
  vi.spyOn(store, "decideApproval").mockImplementation((ctx, input) =>
    original(ctx, input).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          decisions.push({ won: result.won !== null, credentials: result.credentials ?? [] });
        }),
      ),
    ),
  );
  const heldDb = observeStatements(env.DB, async (sql) => {
    if (sql.startsWith("UPDATE approvals SET state = 'approved'")) {
      if (++arrivals === 2) together.resolve();
      await release.promise;
    }
  });
  const first = post(f, id, "approve", { digest: d }, testEnv({ DB: heldDb }));
  const second = post(f, id, "approve", { digest: d }, testEnv({ DB: heldDb }));
  await together.promise;
  release.resolve();
  await Promise.all([first, second]);
  expect(decisions).toHaveLength(2);
  expect(decisions.map((r) => r.won).sort((a, b) => Number(a) - Number(b))).toEqual([false, true]);
  expect(decisions.find((r) => !r.won)!.credentials).toEqual([]);
  expect(decisions.find((r) => r.won)!.credentials).toHaveLength(1);
  expect(google.labelRequests).toHaveLength(1);
  expect(await get(f, id)).toHaveProperty("result.labels");
});

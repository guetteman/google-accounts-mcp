import { env } from "cloudflare:workers";
import { Effect, Result } from "effect";
import { expect, it, vi } from "vite-plus/test";
import "./support/account-checks";
import { allowedAccountStatement, decodeAllowedAccount } from "../src/accounts/store";
import { readConfig } from "../src/config";
import { parseConnectionId } from "../src/connections/model";
import { executeAccount, CALL_DEADLINE, SEND_RESERVE, type CallContext } from "../src/mcp/call";
import { ToolFailure } from "../src/mcp/failures";
import { TOOLS } from "../src/mcp/tools";
import { normalizeEmail, readOwner } from "../src/owner/owner";
import { answer, decided, digest, page, post, row } from "./support/approvals";
import { callRows, expectError, PERSONAL, permission } from "./support/permissions";
import { onceRows } from "./support/draft";
import { observeStatements } from "./support/db";
import { google, deferred } from "./support/google";
import {
  created,
  hold,
  never,
  sendCall,
  sendCases,
  sendFixture,
  sent,
  setSend,
} from "./support/send";
import { ORIGIN, testEnv } from "./support/worker";

it.each(sendCases)("W1 W5: a denied $name cannot reach the sending request", async ({ name }) => {
  const f = await sendFixture(name);
  await permission(f);
  if (name === "send_draft") {
    let work: Promise<void> | undefined;
    const db = observeStatements(
      env.DB,
      () => {},
      (sql) => {
        if (!work && sql.startsWith("INSERT INTO once")) work = setSend(f, name, "deny");
      },
    );
    // Hold the SELECT in the final batch until the owner's write has completed.
    const guarded = observeStatements(db, async (sql) => {
      if (sql.includes(" AS ask")) await work;
    });
    await expectError(
      await sendCall(f, name, {}, testEnv({ DB: guarded })),
      "tool_not_allowed",
      /has not allowed send_draft/,
    );
  } else {
    const held = hold(
      name === "forward_message" ? google.uploadAnswers : google.draftCreateAnswers,
      created(),
    );
    const work = sendCall(f, name);
    try {
      await held.entered;
      await setSend(f, name, "deny");
    } finally {
      held.release();
    }
    await expectError(await work, "tool_not_allowed", new RegExp(`has not allowed ${name}`));
    expect(google.deletes).toEqual(["draft-1"]);
  }
  expect(google.sends).toEqual([]);
  expect(await onceRows()).toEqual([]);
});

it("W1: removing the last visible tool reports account_not_available at the last check", async () => {
  const f = await sendFixture();
  const held = hold(google.draftCreateAnswers, created());
  const work = sendCall(f);
  try {
    await held.entered;
    await setSend(f, "send_message", "deny");
  } finally {
    held.release();
  }
  await expectError(await work, "account_not_available", /No account/);
  expect(google.sends).toEqual([]);
  expect(google.deletes).toEqual(["draft-1"]);
});

it("W2: an allow changed to ask sends nothing and its retry asks", async () => {
  const f = await sendFixture();
  const held = hold(google.draftCreateAnswers, created());
  const work = sendCall(f);
  try {
    await held.entered;
    await setSend(f, "send_message", "ask");
  } finally {
    held.release();
  }
  await expectError(await work, "server_unavailable", /server could not complete/);
  expect(google.sends).toEqual([]);
  expect(google.deletes).toEqual(["draft-1"]);
  expect(await onceRows()).toEqual([]);
  expect((await answer(await sendCall(f))).status).toBe("pending");
});

it.each(["deny", "connection", "account"])(
  "W3: an approved send stops after owner changes %s",
  async (change) => {
    const f = await sendFixture("send_message", "ask");
    const id = (await answer(await sendCall(f))).approval as string;
    const shown = await digest(f, id);
    const held = hold(google.draftCreateAnswers, created());
    const work = post(f, id, "approve", { digest: shown }).then(decided);
    try {
      await held.entered;
      if (change === "deny") await setSend(f, "send_message", "deny");
      else if (change === "connection")
        await f.mcp.browser.post(`/connections/${f.connection.id}/revoke`, {});
      else await f.mcp.browser.post(`/accounts/${f.personal.id}/remove`, {});
    } finally {
      held.release();
    }
    expect((await work).state.kind).toBe("failed");
    expect((await row(id))!.outcome).toBe("failed");
    expect((await callRows())[0]!.outcome).toBe("refused");
    expect(google.sends).toEqual([]);
    expect(await onceRows()).toEqual([]);
  },
);

it.each(["direct", "approved"])(
  "W4 O4: %s preparation is cut at the reserve and remains a known failure",
  async (mode) => {
    const f = await sendFixture("send_message", mode === "approved" ? "ask" : "allow");
    const id = mode === "approved" ? ((await answer(await sendCall(f))).approval as string) : null;
    const shown = id ? await digest(f, id) : null;
    const at = Date.now();
    const entered = deferred();
    google.draftCreateAnswers.push((request) => {
      entered.resolve();
      return never(request);
    });
    const db = observeStatements(
      env.DB,
      () => {},
      (sql) => {
        if (sql.startsWith("INSERT INTO once"))
          vi.mocked(Date.now).mockReturnValue(at + (mode === "approved" ? 13_000 : 8_000));
      },
    );
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const work = id
      ? post(f, id, "approve", { digest: shown! }, testEnv({ DB: db })).then(decided)
      : sendCall(f, "send_message", {}, testEnv({ DB: db }));
    await entered.promise;
    await vi.advanceTimersByTimeAsync(7_000);
    if (id) expect(((await work) as Awaited<ReturnType<typeof page>>).state.kind).toBe("failed");
    else
      await expectError(
        (await work) as Response,
        "google_unavailable",
        /Google could not complete/,
      );
    expect(google.sends).toEqual([]);
    expect(google.deletes).toEqual([]);
    expect(await onceRows()).toEqual([]);
    expect((await callRows())[0]!.outcome).toBe("failed");
  },
);

it("W4: a staging response at 16 seconds leaves no send and a known failure", async () => {
  const f = await sendFixture();
  const at = Date.now();
  google.draftCreateAnswers.push(() => {
    vi.mocked(Date.now).mockReturnValue(at + 16_000);
    return created();
  });
  await expectError(await sendCall(f), "google_unavailable", /Google could not complete/);
  expect(google.sends).toEqual([]);
  expect(google.deletes).toEqual([]);
  expect(await onceRows()).toEqual([]);
  expect((await callRows())[0]!.outcome).toBe("failed");
});

it("W4: the reserve is checked after a slow final database read", async () => {
  const f = await sendFixture();
  const at = Date.now();
  let staged = false;
  google.draftCreateAnswers.push(() => {
    staged = true;
    return created();
  });
  const db = observeStatements(
    env.DB,
    () => {},
    (sql) => {
      if (staged && sql.startsWith("SELECT"))
        vi.mocked(Date.now).mockReturnValue(at + CALL_DEADLINE);
    },
  );
  await expectError(
    await sendCall(f, "send_message", {}, testEnv({ DB: db })),
    "google_unavailable",
    /Google could not complete/,
  );
  expect(google.sends).toEqual([]);
  expect(google.deletes).toEqual([]);
  expect(await onceRows()).toEqual([]);
});

it("T12: cleanup and the existing-draft read can run past the reserve", async () => {
  const f = await sendFixture();
  const at = Date.now();
  google.sendAnswers.push(() => {
    vi.mocked(Date.now).mockReturnValue(at + CALL_DEADLINE - SEND_RESERVE + 1);
    return new Response(null, { status: 403 });
  });
  await expectError(await sendCall(f), "google_unavailable", /Google could not complete/);
  expect(google.deletes).toEqual(["draft-1"]);
  vi.mocked(Date.now).mockReturnValue(at);
  await setSend(f, "send_draft", "allow");
  google.sendAnswers.push(() => {
    vi.mocked(Date.now).mockReturnValue(at + 16_000);
    return new Response(null, { status: 400 });
  });
  await expectError(
    await sendCall(f, "send_draft"),
    "message_not_sendable",
    /owner can complete it in Gmail/,
  );
  expect(google.fullDraftRequests).toHaveLength(1);
  expect(google.deletes).toEqual(["draft-1"]);
});

it.each(["direct", "approved"])(
  "W6: the %s final check uses one read batch and no writes",
  async (mode) => {
    const f = await sendFixture("send_message", mode === "approved" ? "ask" : "allow");
    const id = mode === "approved" ? ((await answer(await sendCall(f))).approval as string) : null;
    const shown = id ? await digest(f, id) : null;
    let watching = false;
    const statements: string[] = [];
    let batches = 0;
    google.draftCreateAnswers.push(() => {
      watching = true;
      return created();
    });
    google.sendAnswers.push(() => {
      watching = false;
      return sent();
    });
    const observed = observeStatements(env.DB, (sql) => {
      if (watching) statements.push(sql);
    });
    const db = new Proxy(observed, {
      get(target, key) {
        if (key === "batch")
          return (...args: Parameters<D1Database["batch"]>) => {
            if (watching) batches++;
            return target.batch(...args);
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    if (id)
      expect(
        (await decided(await post(f, id, "approve", { digest: shown! }, testEnv({ DB: db })))).state
          .kind,
      ).toBe("succeeded");
    else await answer(await sendCall(f, "send_message", {}, testEnv({ DB: db })));
    expect(statements).toHaveLength(mode === "direct" ? 2 : 1);
    expect(statements.every((sql) => sql.startsWith("SELECT"))).toBe(true);
    expect(batches).toBe(mode === "direct" ? 1 : 0);
  },
);

it("O3 O4: a failed final check releases its row and closes its audit record", async () => {
  const f = await sendFixture();
  let staged = false;
  google.draftCreateAnswers.push(() => {
    staged = true;
    return created();
  });
  const db = observeStatements(env.DB, (sql) => {
    if (staged && sql.startsWith("SELECT")) throw new Error("database unavailable");
  });
  await expectError(
    await sendCall(f, "send_message", {}, testEnv({ DB: db })),
    "server_unavailable",
    /server could not complete/,
  );
  expect(google.sends).toEqual([]);
  expect(await onceRows()).toEqual([]);
  expect((await callRows())[0]!.outcome).toBe("failed");
  await answer(await sendCall(f));
  expect(google.sends).toHaveLength(1);
});

const context = async (f: Awaited<ReturnType<typeof sendFixture>>): Promise<CallContext> => {
  const config = readConfig(testEnv());
  if (Result.isFailure(config)) throw config.failure;
  const owner = await Effect.runPromise(readOwner(env.DB));
  return {
    db: env.DB,
    config: config.success,
    owner: { generation: owner.generation, email: owner.email! },
    connection: { connectionId: parseConnectionId(f.connection.id)!, app: f.connection.app },
    origin: ORIGIN,
    now: Date.now,
    waitUntil: () => {},
  };
};
it.each([200, 403])(
  "O13: the runner itself protects a send answered %s followed by a classified failure",
  async (status) => {
    const f = await sendFixture();
    const ctx = await context(f);
    const tool = TOOLS.find((t) => t.name === "send_message")!;
    if (tool.kind !== "account" || !tool.create) throw new Error("Missing send tool");
    const allowed = await decodeAllowedAccount(
      await allowedAccountStatement(ctx, tool.name, normalizeEmail(PERSONAL)!).first(),
      ctx.config.tokenKey,
    );
    const broken: typeof tool = {
      ...tool,
      create: (_send, _account, _args, confirm) =>
        Effect.gen(function* () {
          const sending = yield* confirm;
          yield* sending(
            (token, signal) =>
              new Request("https://gmail.googleapis.com/gmail/v1/users/me/drafts/send", {
                method: "POST",
                signal,
                headers: { Authorization: `Bearer ${token}` },
                body: JSON.stringify({ id: "existing-draft" }),
              }),
          );
          return yield* Effect.fail(new ToolFailure({ code: "google_unavailable" }));
        }),
    };
    google.sendAnswers.push(() => new Response(null, { status }));
    const args = { account: PERSONAL, ...sendCases[0].args };
    await expect(
      executeAccount(ctx, broken, allowed, args, Date.now() + CALL_DEADLINE, Effect.void),
    ).rejects.toMatchObject({ code: status === 200 ? "outcome_unknown" : "google_unavailable" });
    expect((await onceRows()).map((r) => r.state)).toEqual(status === 200 ? ["unknown"] : []);
    if (status === 200) {
      await expectError(await sendCall(f), "outcome_unknown", /Ask the owner to look in Sent/);
      expect(google.sends).toHaveLength(1);
    } else {
      await answer(await sendCall(f));
      expect(google.sends).toHaveLength(2);
    }
  },
);

it("W5: an ordinary tool request function refuses the sending path", async () => {
  const f = await sendFixture();
  const ctx = await context(f);
  const tool = TOOLS.find((t) => t.name === "send_message")!;
  if (tool.kind !== "account" || !tool.create) throw new Error("Missing send tool");
  const allowed = await decodeAllowedAccount(
    await allowedAccountStatement(ctx, tool.name, normalizeEmail(PERSONAL)!).first(),
    ctx.config.tokenKey,
  );
  const bypass: typeof tool = {
    ...tool,
    create: (send) =>
      send(
        (_token, signal) =>
          new Request("https://gmail.googleapis.com/gmail/v1/users/me/drafts/send", {
            method: "POST",
            signal,
            body: JSON.stringify({ id: "existing-draft" }),
          }),
      ).pipe(Effect.map(() => ({ message: "must-not-run", thread: "must-not-run" }))),
  };
  await expect(
    executeAccount(
      ctx,
      bypass,
      allowed,
      { account: PERSONAL },
      Date.now() + CALL_DEADLINE,
      Effect.void,
    ),
  ).rejects.toMatchObject({ code: "google_unavailable", released: true });
  expect(google.sends).toEqual([]);
  expect(await onceRows()).toEqual([]);
});

it("O4 W6: an approved final database failure ends failed with its error and a closed audit", async () => {
  const f = await sendFixture("send_message", "ask");
  const id = (await answer(await sendCall(f))).approval as string;
  const shown = await digest(f, id);
  const db = observeStatements(env.DB, (sql) => {
    if (sql.startsWith("SELECT 1 FROM approvals WHERE approvals.id"))
      throw new Error("final read unavailable");
  });
  const props = await decided(await post(f, id, "approve", { digest: shown }, testEnv({ DB: db })));
  expect(props.state).toMatchObject({
    kind: "failed",
    message: "The server could not complete the call. Try again later.",
  });
  expect((await callRows())[0]!.outcome).toBe("failed");
  expect(await onceRows()).toEqual([]);
  expect(google.sends).toEqual([]);
  expect(google.deletes).toEqual(["draft-1"]);
});

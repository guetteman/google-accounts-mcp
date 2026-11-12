import { env } from "cloudflare:workers";
import { http, HttpResponse } from "msw";
import { Effect, Result } from "effect";
import { expect, it, vi } from "vite-plus/test";
import "./support/account-checks";
import { allowedAccountStatement, decodeAllowedAccount } from "../src/accounts/store";
import { readConfig } from "../src/config";
import { parseConnectionId } from "../src/connections/model";
import { executeAccount, CALL_DEADLINE, SEND_RESERVE, type CallContext } from "../src/mcp/call";
import { notReadable, tooLarge, ToolFailure } from "../src/mcp/failures";
import { TOOLS } from "../src/mcp/tools";
import { normalizeEmail, readOwner } from "../src/owner/owner";
import { answer, decided, digest, page, post, row } from "./support/approvals";
import { callRows, expectError, PERSONAL, permission } from "./support/permissions";
import { network } from "./support/network";
import { onceRows } from "./support/draft";
import { observeStatements } from "./support/db";
import { google, deferred, token } from "./support/google";
import {
  leftoverMessage,
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

it.each(sendCases)("a denied $name cannot reach the sending request", async ({ name }) => {
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
    expect(google.storedDrafts.has("draft-1")).toBe(false);
  }
  expect(google.sends).toEqual([]);
  expect(await onceRows()).toEqual([]);
});

it("removing the last visible tool reports account_not_available at the last check", async () => {
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
  expect(google.storedDrafts.has("draft-1")).toBe(false);
});

it("an allow changed to ask sends nothing and its retry asks", async () => {
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
  expect(google.storedDrafts.has("draft-1")).toBe(false);
  expect(await onceRows()).toEqual([]);
  expect((await answer(await sendCall(f))).status).toBe("pending");
});

it.each(["deny", "connection", "account"])(
  "an approved send stops after owner changes %s",
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
  "%s preparation is cut at the reserve and remains a known failure",
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
    else await expectError((await work) as Response, "google_unavailable", leftoverMessage);
    expect(google.sends).toEqual([]);
    expect(google.deletes).toEqual([]);
    expect(await onceRows()).toEqual([]);
    expect((await callRows())[0]!.outcome).toBe("failed");
  },
);

it("a staging response at 16 seconds leaves no send and a known failure", async () => {
  const f = await sendFixture();
  const at = Date.now();
  google.draftCreateAnswers.push(() => {
    vi.mocked(Date.now).mockReturnValue(at + 16_000);
    return created();
  });
  await expectError(await sendCall(f), "google_unavailable", /Google could not complete/);
  expect(google.sends).toEqual([]);
  expect(google.deletes).toEqual(["draft-1"]);
  expect(google.storedDrafts.has("draft-1")).toBe(false);
  expect(await onceRows()).toEqual([]);
  expect((await callRows())[0]!.outcome).toBe("failed");
});

it.each([16_000, CALL_DEADLINE])(
  "checks time after the final database read at %s milliseconds and reports any leftover draft",
  async (elapsed) => {
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
        if (staged && sql.startsWith("SELECT")) vi.mocked(Date.now).mockReturnValue(at + elapsed);
      },
    );
    await expectError(
      await sendCall(f, "send_message", {}, testEnv({ DB: db })),
      "google_unavailable",
      elapsed === CALL_DEADLINE ? leftoverMessage : /Google could not complete/,
    );
    expect(google.sends).toEqual([]);
    expect(google.deletes).toEqual(elapsed === CALL_DEADLINE ? [] : ["draft-1"]);
    expect(google.storedDrafts.has("draft-1")).toBe(elapsed === CALL_DEADLINE);
    expect(await onceRows()).toEqual([]);
  },
);

it("cleanup of a refused send can run past the reserve", async () => {
  const f = await sendFixture();
  const at = Date.now();
  google.sendAnswers.push(() => {
    vi.mocked(Date.now).mockReturnValue(at + CALL_DEADLINE - SEND_RESERVE + 1);
    return new Response(null, { status: 403 });
  });
  await expectError(await sendCall(f), "google_unavailable", /Google could not complete/);
  expect(google.deletes).toEqual(["draft-1"]);
  expect(google.storedDrafts.has("draft-1")).toBe(false);
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
  expect(google.storedDrafts.has("draft-1")).toBe(false);
});

it.each(["direct", "approved"])(
  "the %s final check uses one read batch and no writes",
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

it("a failed final check releases its row and closes its audit record", async () => {
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
    files: env.FILES_KV,
    reader: "later",
    config: config.success,
    owner: { generation: owner.generation, email: owner.email! },
    connection: { connectionId: parseConnectionId(f.connection.id)!, app: f.connection.app },
    origin: ORIGIN,
    now: Date.now,
    waitUntil: () => {},
  };
};
it.each([200, 403, 503])(
  "the runner itself protects a send answered %s followed by a classified failure",
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
          const sending = yield* confirm.check;
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
    ).rejects.toMatchObject({ code: status === 403 ? "google_unavailable" : "outcome_unknown" });
    expect((await onceRows()).map((r) => r.state)).toEqual(status === 403 ? [] : ["unknown"]);
    if (status !== 403) {
      await expectError(await sendCall(f), "outcome_unknown", /Ask the owner to look in Sent/);
      expect(google.sends).toHaveLength(1);
    } else {
      await answer(await sendCall(f));
      expect(google.sends).toHaveLength(2);
    }
  },
);

it.each(
  ["drafts", "messages"].flatMap((resource) =>
    ["", "upload/"].flatMap((prefix) =>
      ["ordinary", "late"].map((channel) => ({
        url: `https://gmail.googleapis.com/${prefix}gmail/v1/users/me/${resource}/send`,
        channel,
      })),
    ),
  ),
)("refuses $url through the $channel request function", async ({ url, channel }) => {
  const f = await sendFixture();
  let writes = 0;
  network.use(
    http.post(url, () => {
      writes++;
      return sent();
    }),
  );
  const ctx = await context(f);
  const tool = TOOLS.find((t) => t.name === "send_message")!;
  if (tool.kind !== "account" || !tool.create) throw new Error("Missing send tool");
  const allowed = await decodeAllowedAccount(
    await allowedAccountStatement(ctx, tool.name, normalizeEmail(PERSONAL)!).first(),
    ctx.config.tokenKey,
  );
  const bypass: typeof tool = {
    ...tool,
    create: (send, _account, _args, confirm) =>
      (channel === "late" ? confirm.late : send)(
        (_token, signal) =>
          new Request(url, {
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
  expect(writes).toBe(0);
  expect(google.sends).toEqual([]);
  expect(await onceRows()).toEqual([]);
});

it("an approved final database failure ends failed with its error and a closed audit", async () => {
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
  expect(google.storedDrafts.has("draft-1")).toBe(false);
});

it("the reserve also bounds preparation waiting for a token refresh", async () => {
  const f = await sendFixture();
  const at = Date.now();
  const entered = deferred();
  google.draftCreateAnswers.push(() => new Response(null, { status: 401 }));
  google.refreshAnswers.push((signal) => {
    entered.resolve();
    return never({ signal });
  });
  const db = observeStatements(
    env.DB,
    () => {},
    (sql) => {
      if (sql.startsWith("INSERT INTO once")) vi.mocked(Date.now).mockReturnValue(at + 8_000);
    },
  );
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let finished = false;
  const work = sendCall(f, "send_message", {}, testEnv({ DB: db })).then((response) => {
    finished = true;
    return response;
  });
  await entered.promise;
  try {
    await vi.advanceTimersByTimeAsync(7_000);
    expect(finished).toBe(true);
    await expectError(await work, "google_unavailable", leftoverMessage);
    expect(google.sends).toEqual([]);
    expect(await onceRows()).toEqual([]);
  } finally {
    await vi.advanceTimersByTimeAsync(3_000);
    await work;
  }
});

it.each(
  (["send_message", "forward_message"] as const).flatMap((name) =>
    ["lost", "500", "unreadable"].map((outcome) => ({ name, outcome })),
  ),
)("reports a draft left by a $outcome staging answer for $name", async ({ name, outcome }) => {
  const f = await sendFixture(name);
  (name === "send_message" ? google.draftCreateAnswers : google.uploadAnswers).push(() =>
    outcome === "lost"
      ? HttpResponse.error()
      : outcome === "500"
        ? new Response(null, { status: 500 })
        : new Response("not JSON"),
  );
  await expectError(await sendCall(f, name), "google_unavailable", leftoverMessage);
  expect(google.storedDrafts.has("draft-1")).toBe(true);
  expect(await onceRows()).toEqual([]);
  expect((await callRows()).at(-1)!.outcome).toBe("failed");
  expect(google.sends).toEqual([]);
});

it("cuts an in-flight staging request at the reserve, releases its row and reports the draft", async () => {
  const f = await sendFixture();
  const at = Date.now();
  const entered = deferred();
  let aborted = false;
  const db = observeStatements(
    env.DB,
    () => {},
    (sql) => {
      if (sql.startsWith("INSERT INTO once")) vi.mocked(Date.now).mockReturnValue(at + 8_000);
    },
  );
  google.draftCreateAnswers.push((request) => {
    request.signal.addEventListener("abort", () => {
      aborted = true;
    });
    entered.resolve();
    return never(request);
  });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const work = sendCall(f, "send_message", {}, testEnv({ DB: db }));
  await entered.promise;
  try {
    await vi.advanceTimersByTimeAsync(7_000);
    await expectError(await work, "google_unavailable", leftoverMessage);
    expect(aborted).toBe(true);
    expect(google.sends).toEqual([]);
    expect(await onceRows()).toEqual([]);
    expect(google.storedDrafts.has("draft-1")).toBe(true);
  } finally {
    await vi.advanceTimersByTimeAsync(3_000);
    await work;
  }
});

it("refreshes an existing draft's token before the last check so a deny prevents sending", async () => {
  const f = await sendFixture("send_draft");
  await permission(f);
  await env.DB.prepare("UPDATE accounts SET access_expires_at = 0 WHERE id = ?")
    .bind(f.personal.id)
    .run();
  const entered = deferred();
  const released = deferred();
  google.refreshAnswers.push(async () => {
    entered.resolve();
    await released.promise;
    return Response.json({ access_token: token(), expires_in: 3600 });
  });
  const work = sendCall(f, "send_draft");
  await entered.promise;
  try {
    await setSend(f, "send_draft", "deny");
  } finally {
    released.resolve();
  }
  await expectError(await work, "tool_not_allowed", /has not allowed send_draft/);
  expect(google.sends).toEqual([]);
  expect(google.fullDraftRequests).toEqual([
    "https://gmail.googleapis.com/gmail/v1/users/me/drafts/existing-draft?format=minimal",
  ]);
  expect(await onceRows()).toEqual([]);
  await expectError(await sendCall(f, "send_draft"), "tool_not_allowed", /has not allowed/);
});

it.each(["send_draft", "send_message"] as const)(
  "never retries a sending request after a 401 and a deny during refresh for %s",
  async (name) => {
    const f = await sendFixture(name);
    await permission(f);
    const entered = deferred();
    const released = deferred();
    google.sendAnswers.push(() => new Response(null, { status: 401 }));
    google.refreshAnswers.push(async () => {
      entered.resolve();
      await released.promise;
      return Response.json({ access_token: token(), expires_in: 3600 });
    });
    const work = sendCall(f, name);
    await entered.promise;
    try {
      await setSend(f, name, "deny");
    } finally {
      released.resolve();
    }
    await expectError(await work, "google_unavailable", /Google could not complete/);
    expect(google.sends).toHaveLength(1);
    expect(await onceRows()).toEqual([]);
    expect((await callRows()).at(-1)!.outcome).toBe("failed");
    if (name === "send_message") expect(google.storedDrafts.has("draft-1")).toBe(false);
    await expectError(await sendCall(f, name), "tool_not_allowed", /has not allowed/);
    expect(google.sends).toHaveLength(1);
  },
);

it.each(["send_draft", "send_message"] as const)(
  "releases a refused send when its 401 token refresh fails for %s",
  async (name) => {
    const f = await sendFixture(name);
    google.sendAnswers.push(() => new Response(null, { status: 401 }));
    google.refreshAnswers.push(503);
    await expectError(await sendCall(f, name), "google_unavailable", /Google could not complete/);
    expect(google.sends).toHaveLength(1);
    expect(await onceRows()).toEqual([]);
    expect((await callRows()).at(-1)!.outcome).toBe("failed");
  },
);

it.each(["attachment_too_large", "attachment_not_readable"] as const)(
  "preserves the fields of a released %s failure and drops unknown",
  async (code) => {
    const f = await sendFixture();
    const ctx = await context(f);
    const tool = TOOLS.find((entry) => entry.name === "send_message")!;
    if (tool.kind !== "account" || !tool.create) throw new Error("Missing send tool");
    const allowed = await decodeAllowedAccount(
      await allowedAccountStatement(ctx, tool.name, normalizeEmail(PERSONAL)!).first(),
      ctx.config.tokenKey,
    );
    const file = { filename: "report.pdf", type: "application/pdf", size: 1_000 };
    const original = code === "attachment_too_large" ? tooLarge(file, 500) : notReadable(file);
    const data: ConstructorParameters<typeof ToolFailure>[0] = original;
    const failure = new ToolFailure({ ...data, unknown: true });
    const broken: typeof tool = { ...tool, create: () => Effect.fail(failure) };
    const released = await executeAccount(
      ctx,
      broken,
      allowed,
      { account: PERSONAL },
      Date.now() + CALL_DEADLINE,
      Effect.void,
    ).catch((error: unknown) => error);
    expect(released).toMatchObject({ code, file, released: true });
    if (code === "attachment_too_large") expect(released).toHaveProperty("limit", 500);
    expect(released).not.toHaveProperty("unknown");
    expect(await onceRows()).toEqual([]);
  },
);

it("forgets an earlier refusal before recording the next sending request's lost answer", async () => {
  const f = await sendFixture();
  const ctx = await context(f);
  const tool = TOOLS.find((entry) => entry.name === "send_message")!;
  if (tool.kind !== "account" || !tool.create) throw new Error("Missing send tool");
  const allowed = await decodeAllowedAccount(
    await allowedAccountStatement(ctx, tool.name, normalizeEmail(PERSONAL)!).first(),
    ctx.config.tokenKey,
  );
  const broken: typeof tool = {
    ...tool,
    create: (_send, _account, _args, confirm) =>
      Effect.gen(function* () {
        const sending = yield* confirm.check;
        const attempt = () =>
          sending(
            (token, signal) =>
              new Request("https://gmail.googleapis.com/gmail/v1/users/me/drafts/send", {
                method: "POST",
                signal,
                headers: { Authorization: `Bearer ${token}` },
                body: JSON.stringify({ id: "existing-draft" }),
              }),
          );
        yield* attempt();
        yield* Effect.result(attempt());
        return yield* Effect.fail(new ToolFailure({ code: "google_unavailable" }));
      }),
  };
  google.sendAnswers.push(
    () => new Response(null, { status: 403 }),
    () => HttpResponse.error(),
  );
  await expect(
    executeAccount(
      ctx,
      broken,
      allowed,
      { account: PERSONAL },
      Date.now() + CALL_DEADLINE,
      Effect.void,
    ),
  ).rejects.toMatchObject({ code: "outcome_unknown" });
  expect(google.sends).toHaveLength(2);
  expect((await onceRows()).map((entry) => entry.state)).toEqual(["unknown"]);
});

it("keeps a checked messages/send request unknown after the stub fails", async () => {
  const f = await sendFixture();
  const ctx = await context(f);
  const tool = TOOLS.find((entry) => entry.name === "send_message")!;
  if (tool.kind !== "account" || !tool.create) throw new Error("Missing send tool");
  const allowed = await decodeAllowedAccount(
    await allowedAccountStatement(ctx, tool.name, normalizeEmail(PERSONAL)!).first(),
    ctx.config.tokenKey,
  );
  let writes = 0;
  network.use(
    http.post("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", () => {
      writes++;
      return sent();
    }),
  );
  const stub: typeof tool = {
    ...tool,
    create: (_send, _account, _args, confirm) =>
      Effect.gen(function* () {
        const sending = yield* confirm.check;
        yield* sending(
          (token, signal) =>
            new Request("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
              method: "POST",
              signal,
              headers: { Authorization: `Bearer ${token}` },
              body: "{}",
            }),
        );
        return yield* Effect.fail(new ToolFailure({ code: "google_unavailable" }));
      }),
  };
  const args = { account: PERSONAL, ...sendCases[0].args };
  await expect(
    executeAccount(ctx, stub, allowed, args, Date.now() + CALL_DEADLINE, Effect.void),
  ).rejects.toMatchObject({ code: "outcome_unknown" });
  expect((await onceRows())[0]!.state).toBe("unknown");
  await expectError(await sendCall(f), "outcome_unknown", /Ask the owner to look in Sent/);
  expect(writes).toBe(1);
});

it("starts no preparing request after the reserve even before its timer fires", async () => {
  const f = await sendFixture();
  const ctx = await context(f);
  const at = Date.now();
  const tool = TOOLS.find((entry) => entry.name === "send_message")!;
  if (tool.kind !== "account" || !tool.create) throw new Error("Missing send tool");
  const allowed = await decodeAllowedAccount(
    await allowedAccountStatement(ctx, tool.name, normalizeEmail(PERSONAL)!).first(),
    ctx.config.tokenKey,
  );
  const stub: typeof tool = {
    ...tool,
    create: (send) =>
      Effect.gen(function* () {
        vi.mocked(Date.now).mockReturnValue(at + CALL_DEADLINE - SEND_RESERVE + 1);
        yield* send(
          (token, signal) =>
            new Request("https://gmail.googleapis.com/gmail/v1/users/me/labels", {
              signal,
              headers: { Authorization: `Bearer ${token}` },
            }),
        );
        return yield* Effect.fail(new ToolFailure({ code: "google_unavailable" }));
      }),
  };
  await expect(
    executeAccount(ctx, stub, allowed, { account: PERSONAL }, at + CALL_DEADLINE, Effect.void),
  ).rejects.toMatchObject({ code: "google_unavailable", released: true });
  expect(google.labelRequests).toEqual([]);
  expect(await onceRows()).toEqual([]);
});

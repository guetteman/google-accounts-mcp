import { env } from "cloudflare:workers";
import { Effect, Result } from "effect";
import { HttpResponse } from "msw";
import { expect, it, vi } from "vite-plus/test";
import "./support/account-checks";
import { WINDOW, STALE, take, settle, release, type Claim } from "../src/once/store";
import { identityOf } from "../src/once/identity";
import { executeAccount, CALL_DEADLINE, type CallContext } from "../src/mcp/call";
import { TOOLS, parseAccountTool } from "../src/mcp/tools";
import { readConfig, type TokenKey } from "../src/config";
import { normalizeEmail, readOwner } from "../src/owner/owner";
import { allowedAccountStatement, decodeAllowedAccount } from "../src/accounts/store";
import { parseAccountId } from "../src/accounts/model";
import { parseConnectionId } from "../src/connections/model";
import { scheduled } from "../src/approvals/scheduled";
import { answer, approve, decided, digest, get, post, row, rows } from "./support/approvals";
import { draftCall, draftFixture, onceRows, setDraft, decodedMail } from "./support/draft";
import { deferred, google } from "./support/google";
import { callRows, expectError, PERSONAL, permission, toolCall } from "./support/permissions";
import { observeStatements, statementFailingDb } from "./support/db";
import { McpClient } from "./support/oauth";
import { ORIGIN, testEnv } from "./support/worker";

const DAY = 24 * 3_600_000;
const ids = { account: PERSONAL, draft: "draft-1", message: "message-1", thread: "thread-1" };
const atSeconds = (at: number) => new Date(at).toISOString().replace(/\.\d{3}Z$/, "Z");
const repeated = (at: number) => ({
  ...ids,
  repeat_of: atSeconds(at),
  note: `This call already ran at ${atSeconds(at)}. Nothing was created or sent again. This is its result. To make one more on purpose, call again with duplicate: 2.`,
});
const running = {
  status: "running",
  note: "The same call is still running. Call again with the same arguments in a few seconds.",
};
const unknownMessage = (until: number, next: number | null = 2) =>
  `The server does not know whether the draft was created in ${PERSONAL}. Ask the owner to look in Drafts. Until ${atSeconds(until)}, repeating this call does not create it again.${next === null ? "" : ` If the owner says that the draft is missing, call again with duplicate: ${next}.`}`;
const holdCreate = () => {
  const entered = deferred();
  const released = deferred();
  google.draftCreateAnswers.push(async () => {
    entered.resolve();
    await released.promise;
    return Response.json({ id: "draft-1", message: { id: "message-1", threadId: "thread-1" } });
  });
  return { entered: entered.promise, release: released.resolve };
};

it("returns the first result on a repeat and records repeat without another creation", async () => {
  const f = await draftFixture();
  const at = Date.now();
  expect(await answer(await draftCall(f))).toEqual(ids);
  vi.mocked(Date.now).mockReturnValue(at + 5000);
  expect(await answer(await draftCall(f))).toEqual(repeated(at));
  expect(google.draftCreates).toHaveLength(1);
  expect((await callRows()).map((row) => row.outcome)).toEqual(["success", "repeat"]);
});

it("creates a deliberate second copy once and rejects duplicate 1", async () => {
  const f = await draftFixture();
  await answer(await draftCall(f));
  const second = await answer(await draftCall(f, { duplicate: 2 }));
  expect(second).toMatchObject({ draft: "draft-2" });
  expect(await answer(await draftCall(f, { duplicate: 2 }))).toMatchObject({
    ...second,
    repeat_of: expect.any(String),
  });
  await expectError(
    await draftCall(f, { duplicate: 1 }),
    "invalid_arguments",
    /The duplicate field/,
  );
  expect(google.draftCreates).toHaveLength(2);
});

it.each(["direct", "approved"])("answers running while a %s creation is held", async (mode) => {
  const f = await draftFixture(mode === "approved" ? "ask" : "allow");
  const id = mode === "approved" ? ((await answer(await draftCall(f))).approval as string) : null;
  const held = holdCreate();
  const first = id ? approve(f, id) : draftCall(f).then(answer);
  try {
    await held.entered;
    expect(await answer(await draftCall(f))).toEqual(running);
    expect(google.draftCreates).toHaveLength(1);
  } finally {
    held.release();
  }
  await first;
  expect(google.draftCreates).toHaveLength(1);
});

it("answers running to an allowed repeat while an approved creation holds the row", async () => {
  const f = await draftFixture("ask");
  const id = (await answer(await draftCall(f))).approval as string;
  const held = holdCreate();
  const first = approve(f, id);
  try {
    await held.entered;
    await setDraft(f, "allow");
    expect(await answer(await draftCall(f))).toEqual(running);
    expect(google.draftCreates).toHaveLength(1);
  } finally {
    held.release();
  }
  expect((await first).state.kind).toBe("succeeded");
  expect(google.draftCreates).toHaveLength(1);
});

it.each(["done", "unknown", "release"] as const)(
  "keeps a later holder's row unchanged for an old claim (%s)",
  async (action) => {
    const f = await draftFixture();
    const ctx = { db: env.DB };
    const at = Date.now();
    const identity = await identityOf(new Uint8Array(32).fill(1) as TokenKey, {
      connection: parseConnectionId(f.connection.id)!,
      account: f.personal.id,
      tool: parseAccountTool("create_draft")!,
      args: { body: "claims" },
      defaults: {},
    });
    const first = await Effect.runPromise(take(ctx, identity, at));
    if (first.kind !== "run") throw new Error("Expected first claim");
    await Effect.runPromise(release(ctx, first.claim));
    const second = await Effect.runPromise(take(ctx, identity, at + 1));
    if (second.kind !== "run") throw new Error("Expected second claim");
    expect(second.claim.value).not.toBe(first.claim.value);
    const read = () =>
      env.DB.prepare("SELECT * FROM once WHERE identity = ?").bind(identity).first();
    const before = await read();
    expect(before).toMatchObject({ state: "running", claim: second.claim.value });
    const change = (claim: Claim) =>
      action === "release"
        ? release(ctx, claim)
        : settle(
            ctx,
            claim,
            at + 2,
            action === "done"
              ? { kind: "done", result: { draft: "r-new", message: "m-new", thread: "t-new" } }
              : { kind: "unknown" },
          );
    await Effect.runPromise(change(first.claim));
    expect(await read()).toEqual(before);
    await Effect.runPromise(change(second.claim));
    if (action === "release") expect(await read()).toBeNull();
    else
      expect(await read()).toMatchObject({
        state: action,
        claim: second.claim.value,
        expires_at: at + 2 + WINDOW,
      });
  },
);

it.each([
  "redirect",
  "server error",
  "non JSON",
  "wrong shape",
  "broken stream",
  "deadline",
  "lost request",
])("keeps an unknown outcome after %s and never sends its repeat", async (kind) => {
  const f = await draftFixture();
  const at = Date.now();
  const entered = deferred();
  google.draftCreateAnswers.push((request) => {
    entered.resolve();
    if (kind === "deadline")
      return new Promise<Response>((_resolve, reject) =>
        request.signal.addEventListener("abort", () => reject(request.signal.reason), {
          once: true,
        }),
      );
    if (kind === "lost request") return HttpResponse.error();
    if (kind === "redirect")
      return new Response(null, {
        status: 302,
        headers: { Location: "https://example.com/elsewhere" },
      });
    if (kind === "server error") return new Response(null, { status: 503 });
    if (kind === "non JSON") return new Response("not JSON");
    if (kind === "wrong shape") return Response.json({ id: "incomplete" });
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new Error("body lost"));
        },
      }),
    );
  });
  if (kind === "deadline") vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const first = draftCall(f);
  if (kind === "deadline") {
    await entered.promise;
    await vi.advanceTimersByTimeAsync(10_000);
  }
  await expectError(await first, "outcome_unknown", unknownMessage(at + WINDOW));
  await expectError(await draftCall(f), "outcome_unknown", unknownMessage(at + WINDOW));
  expect((await onceRows())[0]).toMatchObject({ state: "unknown", expires_at: at + WINDOW });
  expect(google.draftCreates).toHaveLength(1);
  expect((await callRows()).map((row) => row.outcome)).toEqual([null, "repeat"]);
  expect((await answer(await draftCall(f, { duplicate: 2 }))).draft).toBe("draft-2");
});

it.each([400, 403, 429])(
  "releases a refused creating request (%s) for a fresh retry",
  async (status) => {
    const f = await draftFixture();
    google.draftCreateAnswers.push(() => new Response(null, { status }));
    await expectError(await draftCall(f), "google_unavailable", /Google could not complete/);
    expect(await onceRows()).toEqual([]);
    await answer(await draftCall(f));
    expect(google.draftCreates).toHaveLength(2);
  },
);

it("treats a stale running row as unknown and lets only its holder settle late", async () => {
  const f = await draftFixture();
  const at = Date.now();
  const held = holdCreate();
  const first = draftCall(f).then(answer);
  try {
    await held.entered;
    vi.mocked(Date.now).mockReturnValue(at + STALE + 1);
    await expectError(await draftCall(f), "outcome_unknown", unknownMessage(at + WINDOW));
    expect(google.draftCreates).toHaveLength(1);
  } finally {
    held.release();
  }
  await first;
  expect((await onceRows())[0]!.state).toBe("done");
  expect(await answer(await draftCall(f))).toEqual(repeated(at));
});

it.each(["done", "unknown"])(
  "retains %s for 6.9 days and runs afresh at seven days",
  async (state) => {
    const f = await draftFixture();
    const at = Date.now();
    if (state === "unknown")
      google.draftCreateAnswers.push(() => new Response(null, { status: 500 }));
    if (state === "done") await answer(await draftCall(f));
    else await expectError(await draftCall(f), "outcome_unknown", unknownMessage(at + WINDOW));
    vi.mocked(Date.now).mockReturnValue(at + 6.9 * DAY);
    await f.mcp.keepTokens(await f.mcp.refresh());
    if (state === "done") expect(await answer(await draftCall(f))).toEqual(repeated(at));
    else await expectError(await draftCall(f), "outcome_unknown", unknownMessage(at + WINDOW));
    expect(google.draftCreates).toHaveLength(1);
    vi.mocked(Date.now).mockReturnValue(at + WINDOW);
    await f.mcp.keepTokens(await f.mcp.refresh());
    expect((await answer(await draftCall(f))).draft).toBe("draft-2");
    expect(google.draftCreates).toHaveLength(2);
  },
);

it("extends expiry from settle rather than take and cleans expired rows on schedule", async () => {
  const f = await draftFixture();
  const at = Date.now();
  const held = holdCreate();
  const first = draftCall(f).then(answer);
  try {
    await held.entered;
    vi.mocked(Date.now).mockReturnValue(at + DAY);
  } finally {
    held.release();
  }
  await first;
  expect((await onceRows())[0]!.expires_at).toBe(at + DAY + WINDOW);
  vi.mocked(Date.now).mockReturnValue(at + 7.5 * DAY);
  await f.mcp.keepTokens(await f.mcp.refresh());
  expect(await answer(await draftCall(f))).toEqual(repeated(at));
  expect(google.draftCreates).toHaveLength(1);
  await scheduled({} as ScheduledController, testEnv());
  expect(await onceRows()).toHaveLength(1);
  vi.mocked(Date.now).mockReturnValue(at + 8 * DAY);
  await scheduled({} as ScheduledController, testEnv());
  expect(await onceRows()).toEqual([]);
});

it("checks deny before stored results and scopes the identity to the connection", async () => {
  const f = await draftFixture();
  await answer(await draftCall(f));
  await setDraft(f, "deny");
  // Another allowed tool keeps the account visible, so the denial is tool_not_allowed.
  await permission(f);
  await expectError(await draftCall(f), "tool_not_allowed", /has not allowed create_draft/);
  const other = await new McpClient().connect("Other connection");
  const connection = await env.DB.prepare(
    "SELECT id FROM connections WHERE name = 'Other connection'",
  ).first<{ id: string }>();
  await other.browser.post(`/connections/${connection!.id}/permissions`, {
    account: f.personal.id,
    tool: "create_draft",
    setting: "allow",
  });
  expect(
    (await answer(await toolCall(other, "create_draft", { account: PERSONAL, body: "Hello" })))
      .draft,
  ).toBe("draft-2");
  expect(google.draftCreates).toHaveLength(2);
});

it("returns the same waiting approval even at the limit of twenty", async () => {
  const f = await draftFixture("ask");
  const at = Date.now();
  const pending = await answer(await draftCall(f));
  vi.mocked(Date.now).mockReturnValue(at + 60_000);
  expect(await answer(await draftCall(f))).toEqual(pending);
  expect(await rows()).toHaveLength(1);
  for (let duplicate = 2; duplicate <= 20; duplicate++)
    await answer(await draftCall(f, { duplicate }));
  expect(await rows()).toHaveLength(20);
  vi.mocked(Date.now).mockReturnValue(at + 120_000);
  expect(await answer(await draftCall(f))).toEqual(pending);
  expect(await rows()).toHaveLength(20);
  const audit = await callRows();
  expect(audit[1]!.outcome).toBe("repeat");
  expect(audit.at(-1)!.outcome).toBe("repeat");
  expect(google.draftCreates).toEqual([]);
});

it.each(["success", "unknown"])(
  "answers from an approved %s without another approval",
  async (outcome) => {
    const f = await draftFixture("ask");
    const id = (await answer(await draftCall(f))).approval as string;
    if (outcome === "unknown")
      google.draftCreateAnswers.push(() => new Response(null, { status: 500 }));
    expect((await approve(f, id)).state.kind).toBe(outcome === "success" ? "succeeded" : "unknown");
    expect(await get(f, id)).toEqual(
      outcome === "success" ? { status: "success", result: ids } : { status: "unknown" },
    );
    if (outcome === "success")
      expect(await answer(await draftCall(f))).toEqual(repeated(Date.now()));
    else
      await expectError(await draftCall(f), "outcome_unknown", unknownMessage(Date.now() + WINDOW));
    expect(await rows()).toHaveLength(1);
    expect(google.draftCreates).toHaveLength(1);
  },
);

it.each(["allow", "ask"] as const)(
  "keeps the approval waiting after allow and approves once with %s",
  async (setting) => {
    const f = await draftFixture("ask");
    const at = Date.now();
    const pending = await answer(await draftCall(f));
    expect(pending.status).toBe("pending");
    const id = pending.approval as string;
    await setDraft(f, "allow");
    vi.mocked(Date.now).mockReturnValue(at + 60_000);
    expect(await answer(await draftCall(f))).toEqual(pending);
    expect((await callRows()).map((row) => row.outcome)).toEqual(["pending", "repeat"]);
    expect(google.draftCreates).toEqual([]);
    expect(await onceRows()).toEqual([]);
    if (setting === "ask") {
      await setDraft(f, "ask");
      expect(await answer(await draftCall(f))).toEqual(pending);
    }
    expect(await rows()).toHaveLength(1);
    expect((await row(id))!.state).toBe("waiting");
    expect(google.draftCreates).toEqual([]);
    expect(await onceRows()).toEqual([]);

    expect((await approve(f, id)).state.kind).toBe("succeeded");
    expect((await row(id))!.outcome).toBe("success");
    expect(await get(f, id)).toEqual({ status: "success", result: ids });
    expect((await callRows())[0]!.outcome).toBe("success");
    expect(await answer(await draftCall(f))).toEqual(repeated(at + 60_000));
    expect(google.draftCreates).toHaveLength(1);
    expect(await rows()).toHaveLength(1);
    expect(
      (await callRows()).filter((row) => row.tool === "create_draft").map((row) => row.outcome),
    ).toEqual(
      setting === "ask"
        ? ["success", "repeat", "repeat", "repeat"]
        : ["success", "repeat", "repeat"],
    );
  },
);

it.each(["done", "running", "unknown"])(
  "finishes an approval after a direct call passed its waiting lookup first (%s)",
  async (state) => {
    const f = await draftFixture();
    const taking = deferred();
    const released = deferred();
    const db = observeStatements(env.DB, async (sql) => {
      if (/^INSERT INTO once\b/.test(sql)) {
        taking.resolve();
        await released.promise;
      }
    });
    const held = state === "running" ? holdCreate() : null;
    if (state === "unknown")
      google.draftCreateAnswers.push(() => new Response(null, { status: 500 }));
    const first = draftCall(f, {}, testEnv({ DB: db }));
    try {
      await taking.promise;
      await setDraft(f, "ask");
      const id = (await answer(await draftCall(f))).approval as string;
      const viewDigest = await digest(f, id);
      released.resolve();
      if (held) await held.entered;
      else if (state === "done") expect(await answer(await first)).toEqual(ids);
      else await expectError(await first, "outcome_unknown", unknownMessage(Date.now() + WINDOW));
      expect((await decided(await post(f, id, "approve", { digest: viewDigest }))).state.kind).toBe(
        state === "done" ? "succeeded" : "unknown",
      );
      expect(await get(f, id)).toEqual(
        state === "done"
          ? { status: "success", result: repeated(Date.now()) }
          : { status: "unknown" },
      );
      const approval = (await row(id))!;
      expect(approval.outcome).toBe(state === "done" ? "success" : "unknown");
      expect((await callRows()).find((call) => call.id === approval.call_id)!.outcome).toBe(
        "repeat",
      );
      expect(google.draftCreates).toHaveLength(1);
    } finally {
      released.resolve();
      held?.release();
    }
    if (held) await answer(await first);
  },
);

it.each(["rejected", "expired"])(
  "runs directly with allow after its pending approval is %s",
  async (state) => {
    const f = await draftFixture("ask");
    const id = (await answer(await draftCall(f))).approval as string;
    await setDraft(f, "allow");
    if (state === "rejected") await post(f, id, "reject").then(decided);
    else
      await env.DB.prepare("UPDATE approvals SET expires_at = ? WHERE id = ?")
        .bind(Date.now(), id)
        .run();
    expect(await answer(await draftCall(f))).toEqual(ids);
    expect(google.draftCreates).toHaveLength(1);
    expect(await onceRows()).toHaveLength(1);
    expect(await rows()).toHaveLength(1);
  },
);

it("runs duplicate 2 with allow while the original approval still waits", async () => {
  const f = await draftFixture("ask");
  const pending = await answer(await draftCall(f));
  await setDraft(f, "allow");
  expect(await answer(await draftCall(f, { duplicate: 2 }))).toEqual(ids);
  expect(await answer(await draftCall(f))).toEqual(pending);
  expect((await row(pending.approval as string))!.state).toBe("waiting");
  expect(google.draftCreates).toHaveLength(1);
  expect(await onceRows()).toHaveLength(1);
  expect(await rows()).toHaveLength(1);
});

it("fails closed when the waiting approval lookup fails with allow", async () => {
  const f = await draftFixture("ask");
  const id = (await answer(await draftCall(f))).approval as string;
  await setDraft(f, "allow");
  const db = statementFailingDb(/^SELECT id, expires_at FROM approvals\b/);
  await expectError(
    await draftCall(f, {}, testEnv({ DB: db })),
    "server_unavailable",
    "The server could not complete the call. Try again later.",
  );
  expect(google.draftCreates).toEqual([]);
  expect(await onceRows()).toEqual([]);
  expect((await row(id))!.state).toBe("waiting");
  expect((await callRows()).map((row) => row.outcome)).toEqual(["pending", "failed"]);
});

it.each(["rejected", "expired"])(
  "creates a fresh approval after the earlier one is %s",
  async (state) => {
    const f = await draftFixture("ask");
    const pending = await answer(await draftCall(f));
    const id = pending.approval as string;
    if (state === "rejected") await post(f, id, "reject").then(decided);
    else
      await env.DB.prepare("UPDATE approvals SET expires_at = ? WHERE id = ?")
        .bind(Date.now(), id)
        .run();
    const next = await answer(await draftCall(f));
    expect(next.status).toBe("pending");
    expect(next.approval).not.toBe(id);
    expect(await rows()).toHaveLength(2);
    expect(await onceRows()).toEqual([]);
  },
);

it.each(["allow", "ask"] as const)(
  "takes only one creation or approval for concurrent calls with %s",
  async (setting) => {
    const f = await draftFixture(setting);
    const answers = await Promise.all([draftCall(f).then(answer), draftCall(f).then(answer)]);
    if (setting === "allow") {
      expect(google.draftCreates).toHaveLength(1);
      expect(answers.filter((value) => !value.repeat_of && value.status !== "running")).toEqual([
        ids,
      ]);
    } else {
      expect(answers[0]).toEqual(answers[1]);
      expect(await rows()).toHaveLength(1);
      expect(google.draftCreates).toEqual([]);
    }
  },
);

it("canonicalizes defaults, account case and key order but preserves body whitespace", async () => {
  const f = await draftFixture();
  await answer(await draftCall(f));
  expect(
    await answer(
      await draftCall(f, {
        to: [],
        cc: [],
        bcc: [],
        subject: "",
        reply_all: false,
        account: PERSONAL.toUpperCase(),
      }),
    ),
  ).toEqual(repeated(Date.now()));
  expect(
    await answer(await toolCall(f.mcp, "create_draft", { body: "Hello", account: PERSONAL })),
  ).toEqual(repeated(Date.now()));
  expect(google.draftCreates).toHaveLength(1);
  expect(decodedMail().headers.Subject).toBeUndefined();
  const firstRequest = google.draftCreates[0]!.body;
  await answer(
    await draftCall(f, { to: [], cc: [], bcc: [], subject: "", reply_all: false, duplicate: 2 }),
  );
  expect(google.draftCreates[1]!.body).toEqual(firstRequest);
  await answer(await draftCall(f, { body: "Hello " }));
  expect(google.draftCreates).toHaveLength(3);
});

it("stores no call text in once or the audit log", async () => {
  const f = await draftFixture();
  const marker = "PRIVATE_CONTENT_MARKER";
  await answer(
    await draftCall(f, { body: marker, subject: marker, to: [`${marker} <sam@example.com>`] }),
  );
  expect(JSON.stringify((await env.DB.prepare("SELECT * FROM once").all()).results)).not.toContain(
    marker,
  );
  expect(JSON.stringify(await callRows())).not.toContain(marker);
});

it("derives stable, keyed identities and compares defaults deeply without normalizing strings", async () => {
  const f = await draftFixture();
  const tool = TOOLS.find((tool) => tool.name === "create_draft")!;
  if (tool.kind !== "account" || !tool.create) throw new Error("Missing creating tool");
  const key = new Uint8Array(32).fill(1) as TokenKey;
  const call = {
    connection: parseConnectionId(f.connection.id)!,
    account: f.personal.id,
    tool: tool.name,
    args: { body: "Hello" },
    defaults: { to: [], subject: "", reply_all: false },
  };
  const first = await identityOf(key, call);
  expect(first).toMatch(/^v1\.[a-f0-9]{64}$/);
  expect(
    await identityOf(key, {
      ...call,
      args: { reply_all: false, body: "Hello", subject: "", to: [] },
    }),
  ).toBe(first);
  expect(await identityOf(new Uint8Array(32).fill(2) as TokenKey, call)).not.toBe(first);
  expect(await identityOf(key, { ...call, args: { body: "Hello " } })).not.toBe(first);
  expect(await identityOf(key, { ...call, args: { body: "é" } })).not.toBe(
    await identityOf(key, { ...call, args: { body: "e\u0301" } }),
  );
  // Independent HKDF/HMAC vector, with an empty HKDF salt and the canonical JSON string.
  expect(
    await identityOf(key, {
      ...call,
      connection: parseConnectionId("11111111-1111-4111-8111-111111111111")!,
      account: parseAccountId("aaaaaaaa-aaaa-4aaa-8aaa-000000000001")!,
    }),
  ).toBe("v1.309f81e3634ec57835f6667c9020e765b6c0ae3c5c2c9b084f4c264ffe07e246");
});

it.each([false, true])(
  "sends nothing when take's batch fails, including lost response %s",
  async (lost) => {
    const f = await draftFixture();
    const db = lost
      ? observeStatements(
          env.DB,
          () => {},
          (sql) => {
            if (sql.startsWith("INSERT INTO once")) throw new Error("response lost");
          },
        )
      : statementFailingDb(/^INSERT INTO once/);
    await expectError(
      await draftCall(f, {}, testEnv({ DB: db })),
      "server_unavailable",
      /server could not complete/,
    );
    expect(google.draftCreates).toEqual([]);
    if (lost) expect(await answer(await draftCall(f))).toEqual(running);
    else {
      expect(await onceRows()).toEqual([]);
      await answer(await draftCall(f));
      expect(google.draftCreates).toHaveLength(1);
    }
  },
);

it("executeAccount fails closed on an unclassified exception after the creating request", async () => {
  const f = await draftFixture();
  const config = readConfig(testEnv());
  if (Result.isFailure(config)) throw config.failure;
  const owner = await Effect.runPromise(readOwner(env.DB));
  const ctx: CallContext = {
    db: env.DB,
    config: config.success,
    owner: { generation: owner.generation, email: owner.email! },
    connection: { connectionId: parseConnectionId(f.connection.id)!, app: f.connection.app },
    origin: ORIGIN,
    now: Date.now,
    waitUntil: () => {},
  };
  const tool = TOOLS.find((tool) => tool.name === "create_draft")!;
  if (tool.kind !== "account" || !tool.create) throw new Error("Missing creating tool");
  const raw = await allowedAccountStatement(ctx, tool.name, normalizeEmail(PERSONAL)!).first();
  const allowed = await decodeAllowedAccount(raw, ctx.config.tokenKey);
  const create = tool.create;
  const broken = {
    ...tool,
    create: (...args: Parameters<typeof create>) =>
      create(...args).pipe(
        Effect.flatMap(() =>
          Effect.sync(() => {
            throw new Error("unexpected post-request defect");
          }),
        ),
      ),
  };
  const args = { account: PERSONAL, body: "Hello" };
  await expect(
    executeAccount(ctx, broken, allowed, args, Date.now() + CALL_DEADLINE),
  ).rejects.toMatchObject({
    code: "outcome_unknown",
    unknown: true,
    said: unknownMessage(Date.now() + WINDOW),
  });
  expect((await onceRows())[0]!.state).toBe("unknown");
  await expectError(await draftCall(f), "outcome_unknown", unknownMessage(Date.now() + WINDOW));
  expect(google.draftCreates).toHaveLength(1);
});

it("returns Gmail's result when settle fails and keeps retries from creating again", async () => {
  const f = await draftFixture();
  const at = Date.now();
  const db = statementFailingDb(/^UPDATE once SET state = 'done'/);
  expect(await answer(await draftCall(f, {}, testEnv({ DB: db })))).toEqual(ids);
  expect(await answer(await draftCall(f))).toEqual(running);
  vi.mocked(Date.now).mockReturnValue(at + STALE + 1);
  await expectError(await draftCall(f), "outcome_unknown", unknownMessage(at + WINDOW));
  expect(google.draftCreates).toHaveLength(1);
});

it.each([
  { duplicate: 2, next: 3 },
  { duplicate: 99, next: 100 },
  { duplicate: 100, next: null },
])(
  "names the next deliberate copy for done and unknown calls with duplicate $duplicate",
  async ({ duplicate, next }) => {
    const f = await draftFixture();
    await answer(await draftCall(f, { duplicate }));
    const done = await answer(await draftCall(f, { duplicate }));
    expect(done).toEqual({
      ...ids,
      repeat_of: atSeconds(Date.now()),
      note: `This call already ran at ${atSeconds(Date.now())}. Nothing was created or sent again. This is its result.${next === null ? "" : ` To make one more on purpose, call again with duplicate: ${next}.`}`,
    });
    google.draftCreateAnswers.push(() => new Response(null, { status: 500 }));
    await expectError(
      await draftCall(f, { duplicate, body: "uncertain" }),
      "outcome_unknown",
      unknownMessage(Date.now() + WINDOW, next),
    );
    await expectError(
      await draftCall(f, { duplicate, body: "uncertain" }),
      "outcome_unknown",
      unknownMessage(Date.now() + WINDOW, next),
    );
    expect(google.draftCreates).toHaveLength(2);
  },
);

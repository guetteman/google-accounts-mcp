import { env } from "cloudflare:workers";
import { Effect } from "effect";
import { expect, it, vi } from "vite-plus/test";
import "./support/account-checks";
import type { TestEnv } from "./env";
import type { ApprovalPageProps, ViewValue } from "../src/approvals/model";
import { viewDate } from "../src/approvals/model";
import { viewDigest } from "../src/approvals/view";
import { TOOLS } from "../src/mcp/tools";
import { renderPage } from "../src/pages/render";
import { previews } from "../src/pages/previews";
import { deferred, google, THREADS_URL } from "./support/google";
import { answer, decided, get, page, post } from "./support/approvals";
import {
  callRows,
  fixture,
  googleTraffic,
  permission,
  PERSONAL,
  toolCall,
} from "./support/permissions";
import { observeStatements } from "./support/db";
import { ORIGIN, testEnv, textOf } from "./support/worker";
import { asking, message, read, serveThread, THREAD } from "./support/thread";

const readTool = TOOLS.find((t) => t.name === "read_thread")!;
if (readTool.kind !== "account") throw new Error("Missing read_thread");

it("formats a view date with its year and UTC time", () => {
  expect(viewDate(Date.UTC(2025, 0, 5, 7, 3))).toBe("Jan 5, 2025 at 07:03 UTC");
});

it("with ask, returns pending without contacting Google", async () => {
  serveThread([message()]);
  const before = googleTraffic().length;
  const f = await asking();
  expect(f.id).toMatch(/^[0-9a-f-]{36}$/);
  expect(googleTraffic().slice(before)).toEqual([]);
  expect((await callRows()).map((r) => r.outcome)).toEqual(["pending"]);
});

it.each([undefined, "m4", "m4+18000"])(
  "builds Gmail's metadata view and page position for %s",
  async (start) => {
    serveThread(Array.from({ length: 7 }, (_, i) => message(`m${i + 1}`)));
    const f = await asking(start ? { page: start } : {});
    const props = await page(f, f.id);
    expect(props.state).toMatchObject({ kind: "waiting", shown: true, digest: expect.any(String) });
    expect(props.request.tool).toMatchObject({
      label: "Read thread",
      action: "read a thread",
      joiner: "in",
    });
    expect(props.request.notes).toEqual([]);
    expect(props.request.values).toEqual([
      { name: "Subject", text: "Lunch", from: "gmail" },
      { name: "Messages", text: "7", from: "gmail" },
      { name: "Last message from", text: "Sam <sam@example.com>", from: "gmail" },
      { name: "Last message date", text: "Nov 11, 2026 at 09:41 UTC", from: "gmail" },
      ...(start
        ? [
            {
              name: "Starts at",
              text: `Message 4 of 7${start.includes("+") ? ", after its first 18,000 characters" : ""}`,
              from: "agent",
            },
          ]
        : []),
    ]);
    const text = textOf(await renderPage(props).text());
    if (start) {
      expect(text).toContain(
        "The agent wrote part of the shaded text below, and the server read the rest from Gmail. Each caption says which.",
      );
      for (const label of ["Subject", "Messages", "Last message from", "Last message date"])
        expect(text).toContain(`${label}, read from Gmail`);
      expect(text).toContain("Starts at, written by the agent");
    } else
      expect(text).toContain(
        "The server read the shaded text below from Gmail. The agent did not write it.",
      );
    expect(google.threadRequests.map((r) => r.url)).toEqual([
      `${THREADS_URL}/${THREAD}?format=metadata&metadataHeaders=Subject&metadataHeaders=From`,
    ]);
    expect(google.methods).toEqual(["GET"]);
  },
);

it.each([
  [[{ name: "Query", text: "from:sam", from: "agent" }], "The agent wrote the shaded text below."],
  [
    [{ name: "Subject", text: "Lunch", from: "gmail" }],
    "The server read the shaded text below from Gmail. The agent did not write it.",
  ],
  [
    [
      { name: "Subject", text: "Lunch", from: "gmail" },
      { name: "Body", text: "Reply", from: "agent" },
    ],
    "The agent wrote part of the shaded text below, and the server read the rest from Gmail. Each caption says which.",
  ],
] as [ViewValue[], string][])(
  "explains the source of shaded values %j",
  async (values, sentence) => {
    const source = previews["approval-waiting-thread"] as ApprovalPageProps;
    const props = { ...source, request: { ...source.request, values } };
    const html = await renderPage(props).text();
    const text = textOf(html);
    expect(text).toContain(sentence);
    if (values.length > 1) {
      expect(text).toContain("Subject, read from Gmail");
      expect(text).toContain("Body, written by the agent");
    } else
      expect(text).not.toContain(
        values[0]!.from === "gmail" ? "Subject, read from Gmail" : "Query, written by the agent",
      );
  },
);

it("renders thread, search, notes and label previews at 390 and 1280 pixels without overflow", async () => {
  for (const name of [
    "approval-waiting-thread",
    "approval-waiting-search",
    "approval-waiting-notes",
    "approval-waiting-labels",
    "approval-waiting-labels-many",
  ])
    for (const width of [390, 1280]) {
      const response = renderPage(previews[name]!);
      const result = await (
        await (env as TestEnv).TEST_BROWSER.fetch("http://browser/hydrate", {
          method: "POST",
          body: JSON.stringify({
            url: `${ORIGIN}/__pages/${name}`,
            html: await response.text(),
            headers: Object.fromEntries(response.headers),
            layout: true,
            width,
          }),
        })
      ).json<{ overflow: boolean; errors: string[] }>();
      expect(result.errors).toEqual([]);
      expect(result.overflow).toBe(false);
    }
  // Ten Chromium pages, within the existing browser-test budget.
}, 60_000);

it.each([200, 500])(
  "includes notes only when Gmail's %s response allows a view",
  async (status) => {
    serveThread([message()]);
    const f = await asking();
    if (status === 500) google.threadAnswers.set(THREAD, () => new Response(null, { status }));
    const original = readTool.view;
    const notes = [{ text: "This call reads this thread.", warning: false }];
    let readsWhenNoted: number | undefined;
    const makeNotes = vi.fn(() => {
      readsWhenNoted = google.threadRequests.length;
      return notes;
    });
    readTool.view = { ...original, notes: makeNotes };
    try {
      const props = await page(f, f.id);
      expect(props.state).toMatchObject({ kind: "waiting", shown: status === 200 });
      expect(props.request.notes).toEqual(status === 200 ? notes : []);
      expect(makeNotes).toHaveBeenCalledExactlyOnceWith({ account: PERSONAL, thread: THREAD });
      expect(readsWhenNoted).toBe(0);
      expect(google.threadRequests).toHaveLength(1);
    } finally {
      readTool.view = original;
    }
  },
);

it("covers a note's text, warning and order in the view digest", async () => {
  const source = previews["approval-waiting-notes"] as ApprovalPageProps;
  const request = source.request;
  const first = request.notes[0]!;
  const last = request.notes[1]!;
  const variants = [
    request,
    { ...request, notes: [{ ...first, text: "Changed note" }, last] },
    { ...request, notes: [{ ...first, warning: !first.warning }, last] },
    { ...request, notes: [last, first] },
  ];
  const digests = await Promise.all(variants.map(viewDigest));
  expect(new Set(digests).size).toBe(4);
});

it("runs nothing when a note changes after the page showed it", async () => {
  serveThread([message()]);
  const f = await asking();
  const original = readTool.view;
  let text = "This call reads this thread.";
  readTool.view = { ...original, notes: () => [{ text, warning: false }] };
  const run = vi.spyOn(readTool, "run");
  try {
    const shown = await page(f, f.id);
    if (shown.state.kind !== "waiting") throw new Error("Expected waiting");
    text = "This call reads all messages of this thread.";
    const props = await decided(await post(f, f.id, "approve", { digest: shown.state.digest! }));
    expect(props.state).toMatchObject({ kind: "waiting", shown: true, changed: true });
    expect(props.request.notes).toEqual([{ text, warning: false }]);
    expect(run).not.toHaveBeenCalled();
    expect((await callRows()).map((r) => r.outcome)).toEqual(["pending"]);
  } finally {
    readTool.view = original;
  }
});

it.each(["404", "500", "page", "account"])(
  "hides Approve for %s while Reject still works",
  async (failure) => {
    serveThread([message()]);
    const f = await asking(failure === "page" ? { page: "unknown" } : {});
    if (failure === "404" || failure === "500")
      google.threadAnswers.set(THREAD, () => new Response(null, { status: Number(failure) }));
    if (failure === "account")
      await env.DB.prepare("UPDATE accounts SET scopes = '[]' WHERE id = ?")
        .bind(f.personal.id)
        .run();
    const props = await page(f, f.id);
    expect(props.state).toMatchObject({ kind: "waiting", shown: false, digest: null });
    const html = await renderPage(props).text();
    expect(html).not.toContain(">Approve</button>");
    expect(html).toContain(">Reject</button>");
    const before = googleTraffic().length;
    expect((await decided(await post(f, f.id, "reject"))).state.kind).toBe("rejected");
    expect(googleTraffic().slice(before)).toEqual([]);
  },
);

it.each([
  { change: "permission is denied", kind: "permission" },
  { change: "the approval is rejected", kind: "rejected" },
  { change: "the approval expires", kind: "expired" },
])("does not read Gmail when $change after the page reads the approval", async ({ kind }) => {
  serveThread([message()]);
  const f = await asking();
  let read = false;
  const observed = observeStatements(
    env.DB,
    () => {},
    (sql) => {
      if (sql.startsWith("SELECT approvals.id")) read = true;
    },
  );
  // Apply the concurrent change after the snapshot is read and before the credential lookup.
  let changed = false;
  const racing = observeStatements(observed, async () => {
    if (read && !changed) {
      changed = true;
      if (kind === "permission")
        await env.DB.prepare(
          "DELETE FROM permissions WHERE connection_id = ? AND account_id = ? AND tool = 'read_thread'",
        )
          .bind(f.connection.id, f.personal.id)
          .run();
      else if (kind === "rejected")
        await env.DB.prepare(
          "UPDATE approvals SET state = 'rejected', decided_at = ?, arguments = NULL WHERE id = ?",
        )
          .bind(Date.now(), f.id)
          .run();
      else
        await env.DB.prepare("UPDATE approvals SET expires_at = ? WHERE id = ?")
          .bind(Date.now(), f.id)
          .run();
    }
  });
  const before = googleTraffic().length;
  const props = await page(f, f.id, testEnv({ DB: racing }));
  expect(changed).toBe(true);
  expect(googleTraffic().slice(before)).toEqual([]);
  expect(props.state).toMatchObject({ kind: "waiting", shown: false });
});

it("viewing makes no audit row and Reject sends nothing to Google", async () => {
  serveThread([message()]);
  const f = await asking();
  await page(f, f.id);
  expect((await callRows()).map((r) => r.outcome)).toEqual(["pending"]);
  const before = googleTraffic().length;
  expect((await decided(await post(f, f.id, "reject"))).state.kind).toBe("rejected");
  expect(googleTraffic().slice(before)).toEqual([]);
  expect((await callRows()).map((r) => r.outcome)).toEqual(["rejected"]);
});

it("refuses a view's POST before Gmail and hides Approve", async () => {
  serveThread([message()]);
  const f = await asking();
  vi.spyOn(readTool.view, "values").mockImplementation((_args, send) =>
    send(
      (token, signal) =>
        new Request(THREADS_URL, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
          signal,
        }),
    ).pipe(Effect.map(() => [])),
  );
  const before = googleTraffic().length;
  expect((await page(f, f.id)).state).toMatchObject({
    kind: "waiting",
    shown: false,
    digest: null,
  });
  expect(googleTraffic().slice(before)).toEqual([]);
});

it("a new message changes the digest and Approve runs nothing", async () => {
  serveThread([message()]);
  const f = await asking();
  const original = await page(f, f.id);
  if (original.state.kind !== "waiting") throw new Error("Expected waiting");
  const changed = {
    ...original.request,
    values: original.request.values.map((v) => ({ ...v, from: "agent" as const })),
  };
  expect(await viewDigest(changed)).not.toBe(original.state.digest);
  serveThread([message(), message("m2", "New mail")]);
  const props = await decided(await post(f, f.id, "approve", { digest: original.state.digest! }));
  expect(props.state).toMatchObject({ kind: "waiting", shown: true, changed: true });
  expect(props.request.values).toContainEqual({ name: "Messages", text: "2", from: "gmail" });
  expect(
    google.threadRequests.every((r) => new URL(r.url).searchParams.get("format") === "metadata"),
  ).toBe(true);
  expect((await callRows()).map((r) => r.outcome)).toEqual(["pending"]);
});

it("an approved read returns the direct result through get_approval", async () => {
  serveThread([message()]);
  const f = await asking();
  const shown = await page(f, f.id);
  if (shown.state.kind !== "waiting") throw new Error("Expected waiting");
  expect(
    (await decided(await post(f, f.id, "approve", { digest: shown.state.digest! }))).state.kind,
  ).toBe("succeeded");
  const approved = await get(f, f.id);
  await permission(f, f.personal, true, "read_thread");
  expect(approved).toEqual({ status: "success", result: await answer(await read(f)) });
});

it("a thread that disappears after metadata gives failed not_found through get_approval", async () => {
  serveThread([message()]);
  const f = await asking();
  const shown = await page(f, f.id);
  if (shown.state.kind !== "waiting") throw new Error("Expected waiting");
  google.threadAnswers.set(THREAD, () => {
    const request = google.threadRequests.at(-1)!;
    return new URL(request.url).searchParams.get("format") === "metadata"
      ? Response.json({ messages: [message()] })
      : new Response(null, { status: 404 });
  });
  expect(
    (await decided(await post(f, f.id, "approve", { digest: shown.state.digest! }))).state.kind,
  ).toBe("failed");
  expect(await get(f, f.id)).toEqual({
    status: "failed",
    error: {
      code: "not_found",
      message: `No thread "${THREAD}" exists in ${PERSONAL}. A thread ID works only in the account that returned it.`,
    },
  });
});

it("label and search views read no credential and contact no Google service", async () => {
  const f = await fixture();
  const statements: string[] = [];
  const db = observeStatements(env.DB, (sql) => {
    statements.push(sql);
  });
  for (const [tool, args] of [
    ["list_labels", {}],
    ["search_threads", { query: "from:sam" }],
  ] as const) {
    await f.mcp.browser.post(`/connections/${f.connection.id}/permissions`, {
      account: f.personal.id,
      tool,
      setting: "ask",
    });
    const pending = await answer(await toolCall(f.mcp, tool, { account: PERSONAL, ...args }));
    statements.length = 0;
    const before = googleTraffic().length;
    expect((await page(f, pending.approval as string, testEnv({ DB: db }))).state).toMatchObject({
      kind: "waiting",
      shown: true,
    });
    expect(statements).toHaveLength(6); // owner gate reads twice, then the four statements of readApproval
    expect(statements.filter((s) => /a\.refresh_token/.test(s))).toEqual([]);
    expect(googleTraffic().slice(before)).toEqual([]);
  }
});

it("bounds each view request at ten seconds and clears its timers", async () => {
  serveThread([message()]);
  const f = await asking();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  await page(f, f.id);
  expect(vi.getTimerCount()).toBe(0);
  const entered = deferred();
  let aborted = false;
  google.threadAnswers.set(THREAD, (request) => {
    entered.resolve();
    return new Promise<Response>((_resolve, reject) => {
      request.signal.addEventListener(
        "abort",
        () => {
          aborted = true;
          reject(new Error("aborted"));
        },
        { once: true },
      );
    });
  });
  const waiting = page(f, f.id);
  await entered.promise;
  await vi.advanceTimersByTimeAsync(9_999);
  expect(aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(aborted).toBe(true);
  expect((await waiting).state).toMatchObject({ kind: "waiting", shown: false });
  expect(vi.getTimerCount()).toBe(0);
});

it("shortens a forty-thousand-character summary subject on the approval page", async () => {
  const raw = message();
  serveThread([
    {
      ...raw,
      payload: {
        ...raw.payload,
        headers: [
          { name: "Subject", value: "a".repeat(498) + "🙂" + "x".repeat(39500) },
          { name: "From", value: "b".repeat(40000) },
        ],
      },
    },
  ]);
  const f = await asking();
  const props = await page(f, f.id);
  const subject = props.request.values.find((v) => v.name === "Subject")!.text;
  const from = props.request.values.find((v) => v.name === "Last message from")!.text;
  expect(subject.isWellFormed()).toBe(true);
  expect(subject.length).toBeLessThanOrEqual(500);
  expect(from.length).toBeLessThanOrEqual(500);
  expect(subject).toBe("a".repeat(498) + "…");
  expect(from).toBe("b".repeat(499) + "…");
});

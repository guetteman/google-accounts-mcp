import { env } from "cloudflare:workers";
import { Effect } from "effect";
import { expect, it, vi } from "vite-plus/test";
import "./support/account-checks";
import type { TestEnv } from "./env";
import type { ApprovalPageProps, ViewValue } from "../src/approvals/model";
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

it("A1: with ask, returns pending without contacting Google", async () => {
  serveThread([message()]);
  const before = googleTraffic().length;
  const f = await asking();
  expect(f.id).toMatch(/^[0-9a-f-]{36}$/);
  expect(googleTraffic().slice(before)).toEqual([]);
  expect((await callRows()).map((r) => r.outcome)).toEqual(["pending"]);
});

it.each([undefined, "m4", "m4+18000"])(
  "A2: builds Gmail's metadata view and page position for %s",
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
              from: "gmail",
            },
          ]
        : []),
    ]);
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
    "The agent wrote part of the shaded text below, and the server read the rest from Gmail. Each label says which.",
  ],
] as [ViewValue[], string][])(
  "A3: explains the source of shaded values %j",
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

it("A3: renders thread and search previews at 390 and 1280 pixels without overflow", async () => {
  for (const name of ["approval-waiting-thread", "approval-waiting-search"])
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
});

it.each(["404", "500", "page", "account"])(
  "A4: hides Approve for %s while Reject still works",
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

it("A5: rechecks permission after reading the approval and before acquiring its credential", async () => {
  serveThread([message()]);
  const f = await asking();
  let denied = false;
  const db = observeStatements(
    env.DB,
    () => {},
    (sql) => {
      if (!denied && sql.startsWith("SELECT approvals.id")) denied = true;
    },
  );
  // The observer must await the deny before viewCredential reads. Use a promise from the
  // real approval read, then perform the change at the next statement boundary.
  let changed = false;
  const racing = observeStatements(db, async () => {
    if (denied && !changed) {
      changed = true;
      await env.DB.prepare(
        "DELETE FROM permissions WHERE connection_id = ? AND account_id = ? AND tool = 'read_thread'",
      )
        .bind(f.connection.id, f.personal.id)
        .run();
    }
  });
  const before = googleTraffic().length;
  const props = await page(f, f.id, testEnv({ DB: racing }));
  expect(changed).toBe(true);
  expect(props.state).toMatchObject({ kind: "waiting", shown: false });
  expect(googleTraffic().slice(before)).toEqual([]);
});

it("A5: viewing makes no audit row and Reject sends nothing to Google", async () => {
  serveThread([message()]);
  const f = await asking();
  await page(f, f.id);
  expect((await callRows()).map((r) => r.outcome)).toEqual(["pending"]);
  const before = googleTraffic().length;
  expect((await decided(await post(f, f.id, "reject"))).state.kind).toBe("rejected");
  expect(googleTraffic().slice(before)).toEqual([]);
  expect((await callRows()).map((r) => r.outcome)).toEqual(["rejected"]);
});

it("A9: refuses a view's POST before Gmail and hides Approve", async () => {
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

it("A6: a new message changes the digest and Approve runs nothing", async () => {
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

it("A7: an approved read returns the direct result through get_approval", async () => {
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

it("A7: a thread that disappears after metadata gives failed not_found through get_approval", async () => {
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

it("A8: label and search views read no credential and contact no Google service", async () => {
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

it("A4: bounds each view request at ten seconds and clears its timers", async () => {
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

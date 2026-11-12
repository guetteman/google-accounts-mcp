import { env } from "cloudflare:workers";
import { HttpResponse } from "msw";
import { expect, it, vi } from "vite-plus/test";
import "./support/account-checks";
import { renderPage } from "../src/pages/render";
import { previews } from "../src/pages/previews";
import type { ApprovalPageProps } from "../src/approvals/model";
import { answer, decided, get, page, post } from "./support/approvals";
import { deferred, google, LABELS_RESPONSE, THREADS_URL } from "./support/google";
import { callRows, fixture, googleTraffic, PERSONAL } from "./support/permissions";
import { message } from "./support/thread";
import {
  CHANGE,
  asking,
  FIRST,
  labelCall,
  labels,
  LABELS,
  MISSING,
  SECOND,
  setting,
} from "./support/labels";

it("A1 returns pending before any Gmail request", async () => {
  const f = await asking();
  expect(f.id).toMatch(/^[0-9a-f-]{36}$/);
  expect(googleTraffic()).toEqual([]);
  expect((await callRows()).at(-1)).toMatchObject({ tool: "change_labels", outcome: "pending" });
});

it("A2 names the full action in the approval sentence", async () => {
  const f = await asking();
  const props = await page(f, f.id);
  expect(props.state).toMatchObject({ kind: "waiting", shown: true });
  expect(props.request.tool).toEqual({
    label: "Change labels",
    action: "add or remove labels on threads",
    joiner: "in",
    empty: "This call has no other values. The sentence above is the whole call.",
  });
});

it.each([
  {
    add: [],
    remove: ["INBOX"],
    single: "This call archives this thread: it leaves the inbox.",
    plural: "This call archives these threads: they leave the inbox.",
  },
  {
    add: ["INBOX"],
    remove: [],
    single: "This call moves this thread to the inbox.",
    plural: "This call moves these threads to the inbox.",
  },
  {
    add: [],
    remove: ["UNREAD"],
    single: "This call marks this thread as read.",
    plural: "This call marks these threads as read.",
  },
  {
    add: ["UNREAD"],
    remove: [],
    single: "This call marks this thread as unread.",
    plural: "This call marks these threads as unread.",
  },
])(
  "A3 computes the singular and plural notes for add=$add remove=$remove",
  async ({ add, remove, single, plural }) => {
    const f = await fixture();
    await setting(f, "ask");
    labels(LABELS, 2);
    for (const [threads, text] of [
      [[FIRST], single],
      [[FIRST, SECOND], plural],
    ] as const) {
      const pending = await answer(await labelCall(f, { threads, add, remove }));
      expect((await page(f, pending.approval as string)).request.notes).toEqual([
        { text, warning: false },
      ]);
    }
  },
);
it("A3 keeps notes in order and leaves calls without INBOX or UNREAD without notes", async () => {
  const f = await asking({ threads: [FIRST, SECOND], add: ["UNREAD"], remove: ["INBOX"] });
  labels(LABELS, 2);
  expect((await page(f, f.id)).request.notes).toEqual([
    { text: "This call archives these threads: they leave the inbox.", warning: false },
    { text: "This call marks these threads as unread.", warning: false },
  ]);
  const pending = await answer(await labelCall(f, { threads: [FIRST], add: ["Label_12"] }));
  expect((await page(f, pending.approval as string)).request.notes).toEqual([]);
});

it("A4 separates names from missing IDs, preserving order and repeated labels", async () => {
  const f = await asking({
    threads: [FIRST],
    add: ["Label_12", "missing_add_1", "STARRED", "missing_add_2", "Label_12", "STARRED"],
    remove: ["INBOX", "missing_remove"],
  });
  labels();
  const props = await page(f, f.id);
  expect(props.state).toMatchObject({ kind: "waiting", shown: true });
  expect(props.request.values.slice(0, 4)).toEqual([
    { name: "Labels to add", text: "Receipts\nSTARRED\nReceipts\nSTARRED", from: "gmail" },
    {
      name: "Label IDs to add, not found in this account",
      text: "missing_add_1\nmissing_add_2",
      from: "agent",
    },
    { name: "Labels to remove", text: "INBOX", from: "gmail" },
    {
      name: "Label IDs to remove, not found in this account",
      text: "missing_remove",
      from: "agent",
    },
  ]);
});

it.each([400, 404])(
  "A5 shows three threads in order with status %s on the second",
  async (status) => {
    const f = await asking({ ...CHANGE, threads: [FIRST, MISSING, SECOND] });
    google.threadAnswers.set(MISSING, () => new HttpResponse(null, { status }));
    const props = await page(f, f.id);
    expect(props.state).toMatchObject({ kind: "waiting", shown: true });
    expect(props.request.values.filter((value) => value.name.startsWith("Thread"))).toEqual([
      { name: "Thread 1 subject", text: "Lunch", from: "gmail" },
      { name: "Thread 1 messages", text: "2", from: "gmail" },
      { name: "Thread 1 last from", text: "Kim Lee <kim@example.com>", from: "gmail" },
      { name: "Thread 1 last date", text: "Nov 11, 2026 at 09:41 UTC", from: "gmail" },
      { name: "Thread 2 ID, not found in this account", text: MISSING, from: "agent" },
      { name: "Thread 3 subject", text: "Receipt", from: "gmail" },
      { name: "Thread 3 messages", text: "1", from: "gmail" },
      { name: "Thread 3 last from", text: "billing@example.com", from: "gmail" },
      { name: "Thread 3 last date", text: "Nov 9, 2026 at 04:53 UTC", from: "gmail" },
    ]);
  },
);
it("A5 omits a thread number for a single thread", async () => {
  const f = await asking();
  expect((await page(f, f.id)).request.values.slice(-4)).toEqual([
    { name: "Thread subject", text: "Lunch", from: "gmail" },
    { name: "Thread messages", text: "2", from: "gmail" },
    { name: "Thread last from", text: "Kim Lee <kim@example.com>", from: "gmail" },
    { name: "Thread last date", text: "Nov 11, 2026 at 09:41 UTC", from: "gmail" },
  ]);
});

it("A6 bounds the whole subject and sender to 499 characters and an ellipsis", async () => {
  const f = await asking();
  const mail = message();
  google.threadAnswers.set(FIRST, () =>
    HttpResponse.json({
      messages: [
        {
          ...mail,
          payload: {
            ...mail.payload,
            headers: [
              { name: "Subject", value: "s".repeat(5000) },
              { name: "From", value: "f".repeat(5000) },
            ],
          },
        },
      ],
    }),
  );
  const props = await page(f, f.id);
  expect(props.request.values).toContainEqual({
    name: "Thread subject",
    text: "s".repeat(499) + "…",
    from: "gmail",
  });
  expect(props.request.values).toContainEqual({
    name: "Thread last from",
    text: "f".repeat(499) + "…",
    from: "gmail",
  });
});

it("A7 reads labels alone, then metadata with at most five GETs at once", async () => {
  const ids = Array.from({ length: 10 }, (_, i) => `thread_${i}`);
  const f = await asking({ ...CHANGE, threads: ids });
  const labelEntered = deferred(),
    releaseLabel = deferred(),
    threadEntered = deferred(),
    releaseThreads = deferred();
  google.labelAnswers.push(async () => {
    labelEntered.resolve();
    await releaseLabel.promise;
    return HttpResponse.json(LABELS_RESPONSE);
  });
  for (const id of ids)
    google.threadAnswers.set(id, async () => {
      threadEntered.resolve();
      await releaseThreads.promise;
      return HttpResponse.json({ messages: [message()] });
    });
  let open = 0,
    most = 0;
  const fetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const metadata =
      url.startsWith(THREADS_URL) && new URL(url).searchParams.get("format") === "metadata";
    if (metadata) most = Math.max(most, ++open);
    try {
      return await fetch(input, init);
    } finally {
      if (metadata) open--;
    }
  });
  const pending = page(f, f.id);
  try {
    await labelEntered.promise;
    expect(google.threadRequests).toEqual([]);
    releaseLabel.resolve();
    await threadEntered.promise;
    releaseThreads.resolve();
    expect((await pending).state).toMatchObject({ kind: "waiting", shown: true });
    expect(most).toBeLessThanOrEqual(5);
    expect(open).toBe(0);
    expect(google.threadRequests).toHaveLength(10);
    expect(google.methods).toEqual(Array(11).fill("GET"));
    for (const request of google.threadRequests)
      expect(new URL(request.url).searchParams.get("format")).toBe("metadata");
  } finally {
    releaseLabel.resolve();
    releaseThreads.resolve();
    await pending;
  }
});

it.each(["label list 500", "thread 500", "CHAT", "account unavailable"])(
  "A8 hides Approve and keeps Reject for %s",
  async (failure) => {
    const f = await asking(failure === "CHAT" ? { threads: [FIRST], add: ["CHAT"] } : CHANGE);
    if (failure === "label list 500")
      google.labelAnswers.push(() => new HttpResponse(null, { status: 500 }));
    if (failure === "thread 500")
      google.threadAnswers.set(FIRST, () => new HttpResponse(null, { status: 500 }));
    if (failure === "CHAT") labels([{ id: "CHAT", name: "Chats", type: "system" }]);
    if (failure === "account unavailable")
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
    expect(google.modifyRequests).toEqual([]);
  },
);

it.each(["a new message", "a renamed label"])(
  "A9 runs nothing after %s changes the view",
  async (change) => {
    const f = await asking();
    let messages = [message()];
    google.threadAnswers.set(FIRST, () => HttpResponse.json({ messages }));
    const shown = await page(f, f.id);
    if (shown.state.kind !== "waiting") throw new Error("Expected waiting");
    if (change === "a new message") messages = [message(), message("m2")];
    else
      labels(
        LABELS.map((label) => (label.id === "Label_12" ? { ...label, name: "Invoices" } : label)),
        2,
      );
    const props = await decided(await post(f, f.id, "approve", { digest: shown.state.digest! }));
    expect(props.state).toMatchObject({ kind: "waiting", shown: true, changed: true });
    expect(google.modifyRequests).toEqual([]);
    expect((await callRows()).find((call) => call.tool === "change_labels")?.outcome).toBe(
      "pending",
    );
  },
);

it("A10 returns the exact partial result through get_approval and the direct call", async () => {
  const args = { ...CHANGE, threads: [FIRST, MISSING] };
  const f = await asking(args);
  const shown = await page(f, f.id);
  if (shown.state.kind !== "waiting") throw new Error("Expected waiting");
  expect(
    (await decided(await post(f, f.id, "approve", { digest: shown.state.digest! }))).state.kind,
  ).toBe("succeeded");
  const expected = {
    account: PERSONAL,
    threads: [{ thread: FIRST, labels: ["Label_12", "UNREAD"] }],
    not_found: [MISSING],
  };
  expect(await get(f, f.id)).toEqual({ status: "success", result: expected });
  await setting(f, "allow");
  expect(await answer(await labelCall(f, args))).toEqual(expected);
});
it.each(["missing label", "all threads missing"])(
  "A10 retains not_found for an approved call with %s",
  async (missing) => {
    const args =
      missing === "missing label"
        ? { threads: [FIRST], add: ["missing_label"] }
        : { ...CHANGE, threads: [MISSING, "another_missing"] };
    const f = await asking(args);
    const shown = await page(f, f.id);
    if (shown.state.kind !== "waiting") throw new Error("Expected waiting");
    expect(shown.state.shown).toBe(true);
    expect(
      (await decided(await post(f, f.id, "approve", { digest: shown.state.digest! }))).state.kind,
    ).toBe("failed");
    expect(await get(f, f.id)).toEqual({
      status: "failed",
      error: {
        code: "not_found",
        message:
          missing === "missing label"
            ? `No label "missing_label" exists in ${PERSONAL}. A label ID works only in the account that returned it.`
            : `None of the threads "${MISSING}", "another_missing" exists in ${PERSONAL}. A thread ID works only in the account that returned it.`,
      },
    });
    if (missing === "missing label") expect(google.modifyRequests).toEqual([]);
    else
      expect(google.modifyRequests.map((request) => request.thread)).toEqual([
        MISSING,
        "another_missing",
      ]);
  },
);

it("A11 pages and Reject send no writes, and Reject sends no Google request", async () => {
  const f = await asking();
  expect((await page(f, f.id)).state).toMatchObject({ kind: "waiting", shown: true });
  expect(google.modifyRequests).toEqual([]);
  const before = googleTraffic().length;
  expect((await decided(await post(f, f.id, "reject"))).state.kind).toBe("rejected");
  expect(googleTraffic().slice(before)).toEqual([]);
  const next = await answer(await labelCall(f));
  expect((await page(f, next.approval as string)).state).toMatchObject({
    kind: "waiting",
    shown: true,
  });
  expect(google.modifyRequests).toEqual([]);
  expect(google.methods.every((method) => method === "GET")).toBe(true);
});

it("A12 supplies the three-thread and fifteen-thread approval previews", () => {
  const few = previews["approval-waiting-labels"] as ApprovalPageProps;
  const many = previews["approval-waiting-labels-many"] as ApprovalPageProps;
  for (const preview of [few, many]) {
    expect(preview.request.tool).toMatchObject({
      label: "Change labels",
      action: "add or remove labels on threads",
      joiner: "in",
    });
    expect(preview.request.notes).toEqual([
      { text: "This call archives these threads: they leave the inbox.", warning: false },
      { text: "This call marks these threads as read.", warning: false },
    ]);
  }
  expect(few.request.values.filter((value) => value.name.startsWith("Thread"))).toHaveLength(9);
  expect(few.request.values).toContainEqual({
    name: "Thread 2 ID, not found in this account",
    text: MISSING,
    from: "agent",
  });
  expect(many.request.values.filter((value) => value.name.startsWith("Thread"))).toHaveLength(60);
});

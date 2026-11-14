import { HttpResponse } from "msw";
import { expect, it, vi } from "vite-plus/test";
import "./support/account-checks";
import { NOW } from "./support/accounts";
import { answer } from "./support/approvals";
import { deferred, google, MESSAGES_URL } from "./support/google";
import { requests } from "./support/network";
import { rpcResult } from "./support/oauth";
import { callRows, expectError, fixture, permission, PERSONAL } from "./support/permissions";
import { allowed, call, changed, ids15, operations, serveMessages } from "./support/trash";
import { MAX_ITEMS } from "../src/google/gmail";
import { textOf } from "./support/worker";

// The three tools share one input schema, so one tool proves it.
it("rejects invalid message lists before any outbound request", async () => {
  const f = await allowed("trash_messages");
  for (const messages of [
    [],
    Array.from({ length: MAX_ITEMS + 1 }, (_, i) => `m${i + 1}`),
    ["m1", "m1"],
    ["m1", "m2", "m1"],
    [""],
    ["x".repeat(65)],
    ["bad/id"],
    ["bad id"],
    ["bad?id"],
    ["bad%id"],
    ["bad\nid"],
    ["bad\n"],
    ["á"],
    [1],
    null,
    "m1",
  ]) {
    const before = requests.length;
    await expectError(
      await call(f, "trash_messages", messages),
      "invalid_arguments",
      "The messages field must be a list of 1 to 100 different message IDs that read_thread returned.",
    );
    expect(requests.slice(before)).toEqual([]);
  }
  const ids = [
    ...Array.from({ length: MAX_ITEMS - 1 }, (_, i) => `m${i + 1}`),
    "aZ0_-".repeat(12) + "abcd",
  ];
  serveMessages(ids);
  expect(await answer(await call(f, "trash_messages", ids))).toEqual({
    account: PERSONAL,
    messages: changed("trash_messages", ids),
  });
  expect(google.trashRequests).toHaveLength(MAX_ITEMS);
});

it.each(operations)(
  "$name changes exactly the three named messages and nothing else",
  async (op) => {
    const ids = ["m1", "m_2", "m-3"];
    serveMessages(ids);
    const f = await allowed(op.name);
    const before = requests.length;
    expect(await answer(await call(f, op.name, ids))).toEqual({
      account: PERSONAL,
      messages: changed(op.name, ids),
    });
    const urls = ids.map((id) => `${MESSAGES_URL}/${id}${op.suffix}`);
    expect(requests.slice(before)).toEqual(urls);
    expect(google.trashRequests.map(({ method, url }) => ({ method, url }))).toEqual(
      urls.map((url) => ({ method: op.method, url })),
    );
    expect(google.methods).toEqual([op.method, op.method, op.method]);
    expect((await callRows()).map((r) => r.outcome)).toEqual(["success"]);
  },
);

// changeEach paces all three tools the same way, so one tool proves it.
it("refreshes once, sends the first alone and opens at most five", async () => {
  const f = await allowed("trash_messages", { access_expires_at: NOW - 1 });
  const entered = ids15.map(() => deferred());
  const gates = ids15.map(() => deferred());
  let open = 0;
  let most = 0;
  ids15.forEach((id, index) =>
    google.trashAnswers.set(id, async () => {
      most = Math.max(most, ++open);
      entered[index]!.resolve();
      await gates[index]!.promise;
      open--;
      return Response.json({ id, labelIds: ["UNREAD", "TRASH"] });
    }),
  );
  const pending = call(f, "trash_messages", ids15);
  try {
    await entered[0]!.promise;
    expect(google.trashRequests).toHaveLength(1);
    expect(open).toBe(1);
    gates[0]!.resolve();
    await Promise.all(entered.slice(1, 6).map((e) => e.promise));
    expect(open).toBe(5);
    for (const gate of gates) gate.resolve();
    expect(await answer(await pending)).toEqual({
      account: PERSONAL,
      messages: changed("trash_messages", ids15),
    });
    expect(most).toBe(5);
    expect(open).toBe(0);
    expect(google.refreshTokens).toHaveLength(1);
  } finally {
    for (const gate of gates) gate.resolve();
    await pending;
  }
});

it.each(operations)("$name keeps mixed outcomes in input order and records success", async (op) => {
  const ids = [
    "changed",
    "missing404",
    "missing400",
    "denied",
    "rate",
    "server",
    "redirect",
    "lost",
    "last",
  ];
  serveMessages(ids);
  for (const [id, status] of [
    ["missing404", 404],
    ["missing400", 400],
    ["denied", 403],
    ["rate", 429],
    ["server", 500],
    ["redirect", 302],
  ] as const)
    google.trashAnswers.set(id, () => new Response(null, { status }));
  google.trashAnswers.set("lost", () => HttpResponse.error());
  google.trashAnswers.set("last", () =>
    op.method === "DELETE"
      ? new Response(null, { status: 204 })
      : Response.json({ id: "not-the-named-id" }),
  );
  const f = await allowed(op.name);
  expect(await answer(await call(f, op.name, ids))).toEqual({
    account: PERSONAL,
    messages: [...changed(op.name, ["changed"]), ...changed(op.name, ["last"], [])],
    not_found: ["missing404", "missing400"],
    unconfirmed: ["denied", "rate", "server", "redirect", "lost"],
  });
  expect((await callRows()).map((r) => r.outcome)).toEqual(["success"]);
});

it.each(operations.slice(0, 2))("$name leaves malformed 2xx answers unconfirmed", async (op) => {
  const ids = ["changed", "no-id", "bad-labels", "not-json", "redirect"];
  serveMessages(ids);
  google.trashAnswers.set("no-id", () => Response.json({ labelIds: ["UNREAD"] }));
  google.trashAnswers.set("bad-labels", () => Response.json({ id: "bad-labels", labelIds: null }));
  google.trashAnswers.set("not-json", () => new Response("not JSON"));
  google.trashAnswers.set("redirect", () => new Response(null, { status: 302 }));
  const f = await allowed(op.name);
  expect(await answer(await call(f, op.name, ids))).toEqual({
    account: PERSONAL,
    messages: changed(op.name, ["changed"]),
    unconfirmed: ids.slice(1),
  });
});

it.each(operations)("$name refuses one or several missing messages with their IDs", async (op) => {
  const f = await allowed(op.name);
  for (const ids of [["a"], ["a", "b", "c"]]) {
    for (const id of ids) google.trashAnswers.set(id, () => new Response(null, { status: 404 }));
    const subject = ids.length === 1 ? 'No message "a"' : 'None of the messages "a", "b", "c"';
    await expectError(
      await call(f, op.name, ids),
      "not_found",
      `${subject} exists in ${PERSONAL}. A message ID works only in the account that returned it.`,
    );
  }
  expect((await callRows()).map((r) => r.outcome)).toEqual(["refused", "refused"]);
});

// The call deadline and changeEach are shared, so one tool proves it.
it("keeps the first change when the direct deadline passes", async () => {
  const ids = ["m1", "m2", "m3"];
  serveMessages(ids);
  const f = await allowed("trash_messages");
  const entered = deferred();
  const release = deferred();
  google.trashAnswers.set("m1", async () => {
    entered.resolve();
    await release.promise;
    return Response.json({ id: "m1", labelIds: ["UNREAD", "TRASH"] });
  });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const pending = call(f, "trash_messages", ids);
  try {
    await entered.promise;
    vi.spyOn(Date, "now").mockReturnValue(NOW + 20_000);
    // Cross the absolute deadline without expiring the first request's separate timer.
    await vi.advanceTimersByTimeAsync(1);
    release.resolve();
    expect(await answer(await pending)).toEqual({
      account: PERSONAL,
      messages: changed("trash_messages", ["m1"]),
      unconfirmed: ["m2", "m3"],
    });
    expect(google.trashRequests).toHaveLength(1);
    expect((await callRows()).map((r) => r.outcome)).toEqual(["success"]);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    release.resolve();
    await pending;
  }
});

it.each(operations)(
  "$name repeats the requests and returns Gmail's current answers",
  async (op) => {
    const ids = ["m1", "m2"];
    serveMessages(ids);
    const f = await allowed(op.name);
    await answer(await call(f, op.name, ids));
    if (op.name === "delete_messages") {
      for (const id of ids) google.trashAnswers.set(id, () => new Response(null, { status: 404 }));
      await expectError(
        await call(f, op.name, ids),
        "not_found",
        /None of the messages "m1", "m2"/,
      );
    } else await answer(await call(f, op.name, ids));
    expect(google.trashRequests.map((r) => r.url)).toEqual(
      [...ids, ...ids].map((id) => `${MESSAGES_URL}/${id}${op.suffix}`),
    );
  },
);

it("permissions are independent and the connection groups all three tools under Trash and delete", async () => {
  const f = await fixture();
  await permission(f, f.personal, true, "trash_messages");
  const before = requests.length;
  await expectError(
    await call(f, "delete_messages"),
    "tool_not_allowed",
    /has not allowed delete_messages/,
  );
  expect(requests.slice(before)).toEqual([]);
  const names = async () =>
    ((await rpcResult(await f.mcp.call())).tools as { name: string }[]).map((t) => t.name);
  expect(await names()).toEqual([
    "list_accounts",
    "trash_messages",
    "get_approval",
    "create_upload_link",
  ]);
  await permission(f, f.personal, true, "restore_messages");
  await permission(f, f.personal, true, "delete_messages");
  expect(await names()).toEqual([
    "list_accounts",
    "trash_messages",
    "restore_messages",
    "delete_messages",
    "get_approval",
    "create_upload_link",
  ]);
  await permission(f, f.personal, false, "trash_messages");
  expect(await names()).toEqual([
    "list_accounts",
    "restore_messages",
    "delete_messages",
    "get_approval",
    "create_upload_link",
  ]);
  for (const op of operations) {
    const response = await f.mcp.browser.post(`/connections/${f.connection.id}/permissions`, {
      account: f.personal.id,
      tool: op.name,
      setting: "ask",
    });
    expect(await response.json()).toEqual({ outcome: "ok" });
  }
  expect(await names()).toEqual([
    "list_accounts",
    "trash_messages",
    "restore_messages",
    "delete_messages",
    "get_approval",
    "create_upload_link",
  ]);
  const html = await (await f.mcp.browser.get(`/connections/${f.connection.id}`)).text();
  const text = textOf(html);
  const groupStart = text.indexOf("Trash and delete");
  expect(groupStart).toBeGreaterThan(-1);
  for (const op of operations) {
    expect(text.indexOf(op.label)).toBeGreaterThan(groupStart);
    expect(text).toContain(op.permission);
  }
});

it("tools/list publishes the message schemas and annotations", async () => {
  const f = await fixture();
  for (const op of operations) await permission(f, f.personal, true, op.name);
  for (const name of ["list_labels", "search_threads", "read_thread"])
    await permission(f, f.personal, true, name);
  const listed = (await rpcResult(await f.mcp.call())).tools as Array<{
    name: string;
    annotations: Record<string, boolean>;
    inputSchema: {
      type: string;
      required: string[];
      properties: Record<string, unknown>;
    };
  }>;
  for (const op of operations) {
    const tool = listed.find((t) => t.name === op.name)!;
    expect(tool.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: op.destructive,
      idempotentHint: true,
    });
    expect(tool.inputSchema).toMatchObject({
      type: "object",
      required: ["account", "messages"],
      properties: {
        account: { type: "string" },
      },
    });
    expect(tool.inputSchema.properties.messages).toEqual({
      type: "array",
      minItems: 1,
      maxItems: 100,
      uniqueItems: true,
      items: { type: "string", minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9_-]+$" },
    });
  }
  for (const name of ["list_labels", "search_threads", "read_thread"])
    expect(listed.find((t) => t.name === name)!.annotations).toEqual({ readOnlyHint: true });
});

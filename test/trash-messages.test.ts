import { HttpResponse } from "msw";
import { expect, it, vi } from "vite-plus/test";
import "./support/account-checks";
import { NOW } from "./support/accounts";
import { answer } from "./support/approvals";
import { deferred, google, MESSAGES_URL } from "./support/google";
import { requests } from "./support/network";
import { rpcResult } from "./support/oauth";
import {
  callRows,
  expectError,
  fixture,
  permission,
  PERSONAL,
  unavailableMessage,
  unconfirmedMessage,
} from "./support/permissions";
import { allowed, call, changed, ids15, operations, serveMessages } from "./support/trash";
import { textOf } from "./support/worker";

it.each(operations)(
  "$name rejects invalid message lists before any outbound request",
  async (op) => {
    const f = await allowed(op.name);
    for (const messages of [
      [],
      [...ids15, "m16"],
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
        await call(f, op.name, messages),
        "invalid_arguments",
        "The messages field must be a list of 1 to 15 different message IDs that read_thread returned.",
      );
      expect(requests.slice(before)).toEqual([]);
    }
    const ids = [...ids15.slice(0, -1), "aZ0_-".repeat(12) + "abcd"];
    serveMessages(ids);
    expect(await answer(await call(f, op.name, ids))).toEqual({
      account: PERSONAL,
      messages: changed(op.name, ids),
    });
    expect(google.trashRequests).toHaveLength(15);
  },
);

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

it.each(operations)(
  "$name refreshes once, sends the first alone and opens at most five",
  async (op) => {
    const f = await allowed(op.name, { access_expires_at: NOW - 1 });
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
        return op.method === "DELETE"
          ? new Response(null, { status: 204 })
          : Response.json({
              id,
              labelIds: op.name === "restore_messages" ? ["UNREAD"] : ["UNREAD", "TRASH"],
            });
      }),
    );
    const pending = call(f, op.name, ids15);
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
        messages: changed(op.name, ids15),
      });
      expect(most).toBe(5);
      expect(open).toBe(0);
      expect(google.refreshTokens).toHaveLength(1);
    } finally {
      for (const gate of gates) gate.resolve();
      await pending;
    }
  },
);

it.each(operations)("$name stops after the first 500 but continues after 404", async (op) => {
  const f = await allowed(op.name);
  serveMessages(ids15);
  google.trashAnswers.set("m1", () => new Response(null, { status: 500 }));
  await expectError(
    await call(f, op.name, ids15),
    "google_unavailable",
    unconfirmedMessage(PERSONAL),
  );
  expect(google.trashRequests.map((r) => r.url)).toEqual([`${MESSAGES_URL}/m1${op.suffix}`]);
  expect((await callRows()).map((r) => r.outcome)).toEqual([null]);

  google.trashAnswers.set("m1", () => new Response(null, { status: 404 }));
  const before = google.trashRequests.length;
  expect(await answer(await call(f, op.name, ids15))).toEqual({
    account: PERSONAL,
    messages: changed(op.name, ids15.slice(1)),
    not_found: ["m1"],
  });
  expect(google.trashRequests.slice(before)).toHaveLength(15);
});

it.each(operations)(
  "$name asks a reconnecting account for one token and sends no message request",
  async (op) => {
    const f = await allowed(op.name, { access_expires_at: NOW - 1 });
    google.refreshAnswers.push("invalid_grant");
    await expectError(
      await call(f, op.name, ids15),
      "account_needs_reconnect",
      /Ask the owner to reconnect/,
    );
    expect(google.refreshTokens).toHaveLength(1);
    expect(google.trashRequests).toEqual([]);
  },
);

it.each(operations)("$name keeps mixed outcomes in input order and records success", async (op) => {
  const ids = ["changed", "missing404", "missing400", "denied", "rate", "server", "lost", "last"];
  serveMessages(ids);
  for (const [id, status] of [
    ["missing404", 404],
    ["missing400", 400],
    ["denied", 403],
    ["rate", 429],
    ["server", 500],
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
    unconfirmed: ["denied", "rate", "server", "lost"],
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

it.each(operations)(
  "$name records failed for confirmed refusals and leaves unknown failures without an audit outcome",
  async (op) => {
    const f = await allowed(op.name);
    for (const statuses of [
      [404, 429],
      [404, 500],
      [404, 429, 500],
    ]) {
      const ids = statuses.map((status) => `m${status}`);
      ids.forEach((id, index) =>
        google.trashAnswers.set(id, () => new Response(null, { status: statuses[index] })),
      );
      // A confirmed refusal keeps today's text; an unknown outcome says that a repeat is safe.
      await expectError(
        await call(f, op.name, ids),
        "google_unavailable",
        statuses.includes(500) ? unconfirmedMessage(PERSONAL) : unavailableMessage(PERSONAL),
      );
    }
    expect((await callRows()).map((r) => r.outcome)).toEqual(["failed", null, null]);
  },
);

it.each(operations)("$name keeps the first change when the direct deadline passes", async (op) => {
  const ids = ["m1", "m2", "m3"];
  serveMessages(ids);
  const f = await allowed(op.name);
  const entered = deferred();
  const release = deferred();
  google.trashAnswers.set("m1", async () => {
    entered.resolve();
    await release.promise;
    return op.method === "DELETE"
      ? new Response(null, { status: 204 })
      : Response.json({
          id: "m1",
          labelIds: op.name === "restore_messages" ? ["UNREAD"] : ["UNREAD", "TRASH"],
        });
  });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const pending = call(f, op.name, ids);
  try {
    await entered.promise;
    vi.spyOn(Date, "now").mockReturnValue(NOW + 20_000);
    // Cross the absolute deadline without expiring the first request's separate timer.
    await vi.advanceTimersByTimeAsync(1);
    release.resolve();
    expect(await answer(await pending)).toEqual({
      account: PERSONAL,
      messages: changed(op.name, ["m1"]),
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
    const first = await answer(await call(f, op.name, ids));
    if (op.name === "delete_messages") {
      for (const id of ids) google.trashAnswers.set(id, () => new Response(null, { status: 404 }));
      await expectError(
        await call(f, op.name, ids),
        "not_found",
        /None of the messages "m1", "m2"/,
      );
    } else expect(await answer(await call(f, op.name, ids))).toEqual(first);
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
  expect(await names()).toEqual(["list_accounts", "trash_messages", "get_approval"]);
  await permission(f, f.personal, true, "restore_messages");
  await permission(f, f.personal, true, "delete_messages");
  expect(await names()).toEqual([
    "list_accounts",
    "trash_messages",
    "restore_messages",
    "delete_messages",
    "get_approval",
  ]);
  await permission(f, f.personal, false, "trash_messages");
  expect(await names()).toEqual([
    "list_accounts",
    "restore_messages",
    "delete_messages",
    "get_approval",
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

const descriptions: Record<string, string> = {
  trash_messages:
    "Moves messages of one Google account to the trash. `account` is the address of an account that list_accounts returns. `messages` is a list of 1 to 15 different message IDs that read_thread returned for that account; an ID works only in the account that returned it. Only the named messages move: the other messages of their threads stay where they are. In the trash, a message loses the label INBOX and keeps its other labels. Gmail deletes a message for good after 30 days in the trash, and restore_messages takes it out before that. In the result, `messages` holds each message that moved, with its label IDs after the change. `not_found` lists the IDs that the account does not have. `unconfirmed` lists the IDs for which Google did not confirm the change: call again with those IDs. Each of the two is present only when it is not empty. When no message moved, the call returns an error. Calling again with the same IDs is safe: a message that is already in the trash stays there. When the owner sets this tool to ask, it returns a pending approval with a link instead; get_approval returns the result after the owner approves.",
  restore_messages:
    "Takes messages of one Google account out of the trash. `account` is the address of an account that list_accounts returns. `messages` is a list of 1 to 15 different message IDs that read_thread returned for that account; an ID works only in the account that returned it. Only the named messages are restored. In the result, `messages` holds each restored message with its label IDs after the change. A restored message is not back in the inbox: Gmail removes the label INBOX when a message goes to the trash and does not add it back, while the message keeps its other labels, such as UNREAD, STARRED, and the owner's own labels. It stays out of the trash and out of the inbox. `not_found` lists the IDs that the account does not have, which includes messages that were deleted for good. `unconfirmed` lists the IDs for which Google did not confirm the change: call again with those IDs. Each of the two is present only when it is not empty. When no message was restored, the call returns an error. Calling again with the same IDs is safe. When the owner sets this tool to ask, it returns a pending approval with a link instead; get_approval returns the result after the owner approves.",
  delete_messages:
    "Deletes messages of one Google account for good. Gmail cannot bring them back, and they do not go to the trash. Use trash_messages when the owner may want a message back. `account` is the address of an account that list_accounts returns. `messages` is a list of 1 to 15 different message IDs that read_thread returned for that account; an ID works only in the account that returned it. Only the named messages are deleted: the other messages of their threads stay. In the result, `messages` holds the IDs that were deleted. `not_found` lists the IDs that the account does not have. `unconfirmed` lists the IDs for which Google did not confirm the delete: call again with those IDs. Each of the two is present only when it is not empty. When no message was deleted, the call returns an error. A deleted message counts as not found. So when an ID was unconfirmed, or a call failed, got no answer, or ended as unknown, and a later call reports that ID as not found, the message is gone. When the owner sets this tool to ask, it returns a pending approval with a link instead; get_approval returns the result after the owner approves.",
};

it("tools/list publishes the exact descriptions, message schemas and annotations", async () => {
  const f = await fixture();
  for (const op of operations) await permission(f, f.personal, true, op.name);
  for (const name of ["list_labels", "search_threads", "read_thread"])
    await permission(f, f.personal, true, name);
  const listed = (await rpcResult(await f.mcp.call())).tools as Array<{
    name: string;
    description: string;
    annotations: Record<string, boolean>;
    inputSchema: {
      type: string;
      required: string[];
      properties: Record<string, unknown>;
    };
  }>;
  for (const op of operations) {
    const tool = listed.find((t) => t.name === op.name)!;
    expect(tool.description).toBe(descriptions[op.name]);
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
      maxItems: 15,
      uniqueItems: true,
      items: { type: "string", minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9_-]+$" },
    });
  }
  for (const name of ["list_labels", "search_threads", "read_thread"])
    expect(listed.find((t) => t.name === name)!.annotations).toEqual({ readOnlyHint: true });
});

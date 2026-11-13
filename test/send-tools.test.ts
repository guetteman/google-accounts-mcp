import { env } from "cloudflare:workers";
import { observeStatements } from "./support/db";
import { leftoverNote } from "./support/send";
import { renderPage } from "../src/pages/render";
import { draftFixture, draftCall } from "./support/draft";
import { testEnv, textOf } from "./support/worker";
import { expect, it, vi } from "vite-plus/test";
import { HttpResponse } from "msw";
import "./support/account-checks";
import { TOOLS } from "../src/mcp/tools";
import { WINDOW } from "../src/once/store";
import { isoSeconds } from "../src/approvals/model";
import { answer, approve, decided, digest, get, page, post, row, rows } from "./support/approvals";
import {
  callRows,
  expectError,
  googleTraffic,
  PERSONAL,
  permission,
  toolCall,
} from "./support/permissions";
import { decodedMail, onceRows, replyCases, SOURCE, THREAD } from "./support/draft";
import { google, deferred } from "./support/google";
import { rpcResult } from "./support/oauth";
import {
  created,
  fullMessage,
  hold,
  never,
  mime,
  sendCall,
  sendCases,
  sendFixture,
  serveFull,
  setSend,
} from "./support/send";

it.each(sendCases)(
  "$name sends once and returns the stored sending IDs on repeat",
  async ({ name }) => {
    const f = await sendFixture(name);
    const result = await answer(await sendCall(f, name));
    expect(result).toEqual({
      account: PERSONAL,
      message: "sent-1",
      thread: name === "send_draft" || name === "forward_message" ? THREAD : "thread-1",
    });
    expect(google.sends).toEqual([
      {
        url: "https://gmail.googleapis.com/gmail/v1/users/me/drafts/send",
        body: { id: name === "send_draft" ? "existing-draft" : "draft-1" },
        redirect: "manual",
      },
    ]);
    expect(google.draftCreates.length + google.uploads.length).toBe(name === "send_draft" ? 0 : 1);
    expect(google.methods.filter((method) => method === "POST")).toHaveLength(
      name === "send_draft" ? 1 : 2,
    );
    if (name === "send_draft") {
      expect(google.fullDraftRequests).toEqual([
        "https://gmail.googleapis.com/gmail/v1/users/me/drafts/existing-draft?format=minimal",
      ]);
      expect(google.messageRequests).toEqual([]);
      expect(google.storedDrafts.has("existing-draft")).toBe(false);
    } else {
      const text = name === "forward_message" ? google.uploads[0]!.message : decodedMail().text;
      expect(text).not.toMatch(/(?:^|\r\n)(From|Date|Message-ID):/);
    }
    const repeat = await answer(await sendCall(f, name));
    expect(repeat).toMatchObject({ ...result, repeat_of: isoSeconds(Date.now()) });
    expect(String(repeat.note).includes("duplicate")).toBe(name !== "send_draft");
    expect(google.sends).toHaveLength(1);
    expect((await onceRows())[0]!.state).toBe("done");
  },
);

it.each(replyCases.filter((c) => !c.name.startsWith("given")))(
  "send_reply reuses the reply plan for $name",
  async (test) => {
    const f = await sendFixture("send_reply");
    serveFull(fullMessage(test.headers));
    await answer(await sendCall(f, "send_reply", { ...test.args, body: "Exact\n\nreply text" }));
    const mail = decodedMail();
    expect(mail.request.message.threadId).toBe(THREAD);
    expect(mail.headers).toMatchObject({
      Subject: "Re: Lunch",
      "In-Reply-To": "<source@example.com>",
      References: "<earlier@example.com> <source@example.com>",
    });
    expect(mail.headers.To).toBe(test.to);
    expect(mail.headers.Cc).toBe(test.cc);
    expect(mail.body).toBe("Exact\n\nreply text");
  },
);

it("names message and the draft workaround when reply recipients cannot be filled", async () => {
  const f = await sendFixture("send_reply");
  serveFull(
    fullMessage({ To: Array.from({ length: 200 }, (_, i) => `r${i}@example.com`).join(", ") }),
  );
  await expectError(
    await sendCall(f, "send_reply", { reply_all: true }),
    "invalid_arguments",
    "The message field must be a message whose recipients the server can fill in. For this one, create a draft with create_draft, reply_to, and the recipients, and send it with send_draft.",
  );
  expect(google.sends).toEqual([]);
  expect(await onceRows()).toEqual([]);
});

it.each([
  { name: "send_message", args: { to: [] }, field: "to" },
  { name: "send_message", args: { to: undefined }, field: "to" },
  { name: "send_message", args: { subject: undefined }, field: "subject" },
  { name: "forward_message", args: { to: undefined }, field: "to" },
  ...["to", "cc", "bcc"].flatMap((field) => [
    { name: "send_message", args: { [field]: ["not a mailbox"] }, field },
    { name: "forward_message", args: { [field]: ["not a mailbox"] }, field },
    { name: "send_message", args: { [field]: ["x".repeat(999)] }, field },
  ]),
  ...["", "x".repeat(999), "Hi\r\nBcc: thief@example.com"].map((subject) => ({
    name: "send_message",
    args: { subject },
    field: "subject",
  })),
  { name: "forward_message", args: { to: [] }, field: "to" },
  ...["send_reply", "forward_message", "send_draft"].flatMap((name) =>
    ["", "x".repeat(65), "id/path", "é"].map((value) => ({
      name,
      args: { [name === "send_draft" ? "draft" : "message"]: value },
      field: name === "send_draft" ? "draft" : "message",
    })),
  ),
  ...["send_message", "send_reply", "forward_message"].flatMap((name) =>
    [1, 2.5, 101].map((duplicate) => ({ name, args: { duplicate }, field: "duplicate" })),
  ),
] as Array<{
  name: (typeof sendCases)[number]["name"];
  args: Record<string, unknown>;
  field: string;
}>)("refuses invalid $name input %# before Gmail or approval", async ({ name, args, field }) => {
  const f = await sendFixture(name, "ask");
  const traffic = googleTraffic().length;
  await expectError(
    await sendCall(f, name, args),
    "invalid_arguments",
    field === "to"
      ? "The to field must be a list of at least one mailbox, each an address or Name <address>."
      : field === "cc" || field === "bcc"
        ? `The ${field} field must be a list of mailboxes, each an address or Name <address>.`
        : name === "send_message" && field === "subject"
          ? "The subject field must be a string of 1 to 998 characters without control characters."
          : new RegExp(`The ${field} field must be`),
  );
  expect(googleTraffic().slice(traffic)).toEqual([]);
  expect(await onceRows()).toEqual([]);
  expect(await rows()).toEqual([]);
});

it.each([
  "send_message",
  "send_reply",
  "forward_message",
  "send_draft",
  "create_draft",
  "list_labels",
])("oversized denied %s is refused before parsing or binding an account", async (name) => {
  const f = await sendFixture();
  await setSend(f, "send_message", "deny");
  const to = Array.from({ length: 100_000 }, () => "bad");
  await expectError(
    await toolCall(f.mcp, name, { account: PERSONAL, to, body: "Hello" }),
    "invalid_arguments",
    "The arguments are too large. The limit is 256 KB.",
  );
  expect((await callRows()).at(-1)).toMatchObject({
    tool: name,
    account_id: null,
    outcome: "refused",
  });
  expect(google.sends).toEqual([]);
  expect(await onceRows()).toEqual([]);
});

it.each(sendCases)(
  "$name refuses undeclared recipients or actions before ask",
  async ({ name }) => {
    const f = await sendFixture(name, "ask");
    const field = {
      send_message: "reply_to",
      send_reply: "to",
      forward_message: "attachments",
      send_draft: "duplicate",
    }[name];
    await expectError(
      await sendCall(f, name, { [field]: name === "send_draft" ? 2 : ["other@example.com"] }),
      "invalid_arguments",
      `The ${field} field must be left out: this tool has no such field.`,
    );
    expect(await rows()).toEqual([]);
    expect(await onceRows()).toEqual([]);
    expect(google.sends).toEqual([]);
    expect(google.messageRequests).toEqual([]);
  },
);

it.each([400, 404])("a %s source read releases its call for a corrected retry", async (status) => {
  const f = await sendFixture("send_reply");
  google.messageAnswers.set(SOURCE, () => new Response(null, { status }));
  await expectError(
    await sendCall(f, "send_reply"),
    "not_found",
    `No message "${SOURCE}" exists in ${PERSONAL}. A message ID works only in the account that returned it.`,
  );
  expect(await onceRows()).toEqual([]);
  serveFull();
  await answer(await sendCall(f, "send_reply"));
  expect(google.sends).toHaveLength(1);
});

it.each([0, 400, 404])(
  "an absent draft at the preflight read or send (%s) releases its call",
  async (readStatus) => {
    const f = await sendFixture("send_draft");
    if (!readStatus) google.sendAnswers.push(() => new Response(null, { status: 404 }));
    if (readStatus)
      google.fullDraftAnswers.set(
        "existing-draft",
        () => new Response(null, { status: readStatus }),
      );
    await expectError(
      await sendCall(f, "send_draft"),
      "not_found",
      `No draft "existing-draft" exists in ${PERSONAL}. A draft ID works only in the account that returned it.`,
    );
    expect(google.fullDraftRequests).toHaveLength(1);
    expect(await onceRows()).toEqual([]);
    google.fullDraftAnswers.clear();
    await answer(await sendCall(f, "send_draft"));
    expect(google.sends).toHaveLength(readStatus ? 1 : 2);
    expect(google.deletes).toEqual([]);
  },
);

it.each(sendCases)(
  "$name releases refused sends and only removes its staged draft",
  async ({ name }) => {
    const f = await sendFixture(name);
    for (const status of [400, 403, 429]) {
      google.sendAnswers.push(() => new Response(null, { status }));
      await expectError(
        await sendCall(f, name),
        status === 400 ? "message_not_sendable" : "google_unavailable",
        status === 400
          ? name === "send_draft"
            ? `Gmail refused to send draft "existing-draft" from ${PERSONAL}. The usual cause is a draft with no recipient or with an address that is not valid. The owner can complete it in Gmail.`
            : `Gmail refused this message from ${PERSONAL}. The usual cause is an address that is not valid.`
          : /Google could not complete/,
      );
      expect(await onceRows()).toEqual([]);
      expect([...google.storedDrafts.keys()]).toEqual(["existing-draft"]);
      expect((await callRows()).at(-1)!.outcome).toBe(status === 400 ? "refused" : "failed");
    }
    expect(google.deletes).toHaveLength(name === "send_draft" ? 0 : 3);
    expect(google.fullDraftRequests).toHaveLength(name === "send_draft" ? 3 : 0);
    await answer(await sendCall(f, name));
    expect(google.sends).toHaveLength(4);
  },
);

it.each(["send_message", "send_reply", "forward_message"] as const)(
  "%s releases a refused staged draft",
  async (name) => {
    const f = await sendFixture(name);
    (name === "forward_message" ? google.uploadAnswers : google.draftCreateAnswers).push(
      () => new Response(null, { status: 400 }),
    );
    await expectError(
      await sendCall(f, name),
      "message_not_sendable",
      `Gmail refused this message from ${PERSONAL}. The usual cause is an address that is not valid.`,
    );
    expect(google.sends).toEqual([]);
    expect(await onceRows()).toEqual([]);
    await answer(await sendCall(f, name));
    expect(google.sends).toHaveLength(1);
  },
);

it("a failed cleanup preserves the refusal and reports the leftover draft", async () => {
  const f = await sendFixture();
  google.sendAnswers.push(() => new Response(null, { status: 400 }));
  google.deleteAnswers.push(() => new Response(null, { status: 500 }));
  await expectError(
    await sendCall(f),
    "message_not_sendable",
    `Gmail refused this message from ${PERSONAL}. The usual cause is an address that is not valid.${leftoverNote}`,
  );
  expect(google.deletes).toEqual(["draft-1"]);
  expect(google.storedDrafts.has("draft-1")).toBe(true);
  expect(await onceRows()).toEqual([]);
});

it.each(["held", "concurrent"])("%s identical calls send at most once", async (kind) => {
  const f = await sendFixture();
  const held = hold(google.draftCreateAnswers, created());
  const first = sendCall(f).then(answer);
  try {
    await held.entered;
    if (kind === "concurrent") {
      const both = await Promise.all([sendCall(f).then(answer), sendCall(f).then(answer)]);
      expect(both.map((a) => a.status)).toEqual(["running", "running"]);
    } else
      expect(await answer(await sendCall(f))).toEqual({
        status: "running",
        note: "The same call is still running. Call again with the same arguments in a few seconds.",
      });
    expect(google.sends).toEqual([]);
  } finally {
    held.release();
  }
  await first;
  expect(google.sends).toHaveLength(1);
});

it.each(["server", "lost", "deadline", "unreadable", "shape"])(
  "%s sending outcome stays unknown with no cleanup or repeat send",
  async (kind) => {
    const f = await sendFixture();
    const entered = deferred();
    google.sendAnswers.push((request) => {
      entered.resolve();
      if (kind === "deadline") return never(request);
      if (kind === "lost") return HttpResponse.error();
      if (kind === "unreadable") return new Response("not JSON");
      if (kind === "shape") return Response.json({ id: "missing-thread" });
      return new Response(null, { status: 503 });
    });
    if (kind === "deadline") vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const work = sendCall(f);
    if (kind === "deadline") {
      await entered.promise;
      await vi.advanceTimersByTimeAsync(10_000);
    }
    await expectError(await work, "outcome_unknown", /Ask the owner to look in Sent/);
    await expectError(await sendCall(f), "outcome_unknown", /Ask the owner to look in Sent/);
    expect(google.sends).toHaveLength(1);
    expect(google.deletes).toEqual([]);
    expect((await onceRows())[0]!.state).toBe("unknown");
  },
);

it("a 404 sending a staged draft is unknown and cannot send a second copy", async () => {
  const f = await sendFixture();
  google.sendAnswers.push(() => new Response(null, { status: 404 }));
  await expectError(
    await sendCall(f),
    "outcome_unknown",
    /does not know whether this mail went out/,
  );
  await expectError(
    await sendCall(f),
    "outcome_unknown",
    /does not know whether this mail went out/,
  );
  expect(google.sends).toHaveLength(1);
  expect(google.deletes).toEqual([]);
  expect((await onceRows())[0]!.state).toBe("unknown");
});

it.each(sendCases.filter((c) => c.name !== "send_draft"))(
  "$name defaults are identical and duplicate sends deliberately",
  async ({ name }) => {
    const f = await sendFixture(name);
    await answer(await sendCall(f, name));
    const defaults =
      name === "send_reply"
        ? { reply_all: false }
        : name === "forward_message"
          ? { cc: [], bcc: [], body: "" }
          : { cc: [], bcc: [] };
    const repeated = await answer(await sendCall(f, name, defaults));
    expect(repeated.repeat_of).toBe(isoSeconds(Date.now()));
    expect(google.sends).toHaveLength(1);
    await answer(await sendCall(f, name, { ...defaults, duplicate: 2 }));
    const text =
      name === "forward_message"
        ? google.uploads.map((u) => u.message)
        : google.draftCreates.map((_d, i) => decodedMail(i).text);
    if (name !== "forward_message") expect(text[0]).toBe(text[1]);
    else {
      expect(mime(text[0]!).parts).toEqual(mime(text[1]!).parts);
      expect(mime(text[0]!).headers.To).toBe(mime(text[1]!).headers.To);
    }
    await answer(await sendCall(f, name, { duplicate: 2 }));
    expect(google.sends).toHaveLength(2);
    await answer(await sendCall(f, name, { body: "Hello " }));
    expect(google.sends).toHaveLength(3);
  },
);

it.each([undefined, 2, 100])(
  "unknown composed mail gives the exact safe advice for duplicate %s",
  async (duplicate) => {
    const f = await sendFixture();
    google.sendAnswers.push(() => new Response(null, { status: 503 }));
    const args = duplicate === undefined ? {} : { duplicate };
    const next = (duplicate ?? 1) + 1;
    const expected = `The server does not know whether this mail went out from ${PERSONAL}. Ask the owner to look in Sent. If it is not there, it may still be in Drafts, and the owner can send it from Gmail. Until ${isoSeconds(Date.now() + WINDOW)}, repeating this call does not send it again.${next > 100 ? "" : ` Only if the owner says that it is in neither place, call again with duplicate: ${next}.`}`;
    await expectError(await sendCall(f, "send_message", args), "outcome_unknown", expected);
    await expectError(await sendCall(f, "send_message", args), "outcome_unknown", expected);
  },
);
it("an unknown existing draft never suggests duplicate", async () => {
  const f = await sendFixture("send_draft");
  google.sendAnswers.push(() => new Response(null, { status: 503 }));
  await expectError(
    await sendCall(f, "send_draft"),
    "outcome_unknown",
    `The server does not know whether draft "existing-draft" went out from ${PERSONAL}. Ask the owner to look in Sent. If the draft is still in Drafts, the owner can send it from Gmail. Until ${isoSeconds(Date.now() + WINDOW)}, repeating this call does not send it again.`,
  );
});

it("ask deduplicates pending calls, Approve sends once, get_approval returns the send, and Reject sends nothing", async () => {
  const f = await sendFixture("send_message", "ask");
  const pending = await answer(await sendCall(f));
  expect(await answer(await sendCall(f))).toEqual(pending);
  expect(google.sends).toEqual([]);
  expect(google.draftCreates).toEqual([]);
  const id = pending.approval as string;
  expect((await approve(f, id)).state.kind).toBe("succeeded");
  expect(await get(f, id)).toEqual({
    status: "success",
    result: { account: PERSONAL, message: "sent-1", thread: "thread-1" },
  });
  expect(google.sends).toHaveLength(1);
  const rejected = (await answer(await sendCall(f, "send_message", { body: "Do not send" })))
    .approval as string;
  expect((await decided(await post(f, rejected, "reject"))).state.kind).toBe("rejected");
  expect(google.sends).toHaveLength(1);
});

it("lists send warnings and repeats and declares their page actions and permission controls", async () => {
  const f = await sendFixture();
  for (const c of sendCases) await setSend(f, c.name, "allow");
  await permission(f, f.personal, true, "read_thread");
  const tools = (await rpcResult(await f.mcp.call())).tools as Array<{
    name: string;
    annotations: unknown;
    description: string;
  }>;
  const paragraph =
    "Repeating: a call with the same arguments as a call of the last 7 days is the same call. It never sends a second message. It returns the first call's result with repeat_of, or its pending approval. So when you get no answer or an error that says to try again, call again with exactly the same arguments. Copy them; do not reword the text, because changed text is a new message. When the answer says that the outcome is unknown, do not try another wording: ask the owner to look in Gmail.";
  for (const c of sendCases) {
    const tool = tools.find((tool) => tool.name === c.name)!;
    expect(tool.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
    });
    expect(tool.description).toContain(paragraph);
    expect(tool.description).toContain("cannot be taken back");
    expect(tool.description).toContain("get_approval");
    expect(tool.description).toContain(
      "With ask, a send that cannot be built appears on the owner's page, not in your answer.",
    );
    const entry = TOOLS.find((tool) => tool.name === c.name)!;
    expect(entry.kind === "account" && entry.group).toBe("Send");
    const expected = {
      send_message: {
        action: "send a message",
        permissionDescription:
          "Send a new message from this account. A sent message cannot be taken back.",
      },
      send_reply: {
        action: "send a reply",
        permissionDescription:
          "Reply to a message in its thread: to its reply address or its sender, or to everyone on it. A sent reply cannot be taken back.",
      },
      forward_message: {
        action: "forward a message",
        permissionDescription:
          "Forward a message, with its text and its attachments, to the addresses the agent gives. It cannot be taken back.",
      },
      send_draft: {
        action: "send a draft",
        permissionDescription:
          "Send a draft that exists in this account, as it is in Gmail at that moment. It cannot be taken back.",
      },
    }[c.name];
    expect(entry.kind === "account" && entry.view.action).toBe(expected.action);
    expect(entry.kind === "account" && entry.permissionDescription).toBe(
      expected.permissionDescription,
    );
    if (c.name !== "send_draft")
      expect(tool.description).toContain(
        "To send one more message with the same content on purpose, add duplicate: 2 (then 3).",
      );
  }
  expect(tools.find((t) => t.name === "send_reply")!.description).toContain(
    "no quote unless you write one",
  );
  expect(tools.find((t) => t.name === "forward_message")!.description).toContain("25,000,000");
  expect(tools.find((t) => t.name === "send_draft")!.description).toContain("gone from Drafts");
  const forwardDescription = tools.find((tool) => tool.name === "forward_message")!.description;
  const draftDescription = tools.find((tool) => tool.name === "send_draft")!.description;
  for (const description of [forwardDescription, draftDescription]) {
    expect(description).toContain("2,000,000 bytes of body");
    expect(description).toContain("1,000,000 characters");
    expect(description).toContain("3 body parts that Gmail gives apart");
  }
  expect(forwardDescription).toContain("without a file name or attachment ID");
  expect(draftDescription).toContain("cannot show whole cannot be approved");
  expect(draftDescription).toContain("20,000 characters in its From, To, Cc, Bcc, and Subject");
  expect(draftDescription).toContain("a repeated From, To, Cc, Bcc, Subject or Reply-To header");
  expect(draftDescription).toContain("a part that is neither text nor a file");
  const readDescription = tools.find((tool) => tool.name === "read_thread")!.description;
  expect(readDescription).toContain("when it is not empty");
  expect(readDescription).toContain(
    "A reply to the account's own message goes to that message's To",
  );
  await permission(f);
});

it("an existing-draft preflight read failure is known without sending", async () => {
  const f = await sendFixture("send_draft");
  google.fullDraftAnswers.set("existing-draft", () => new Response(null, { status: 500 }));
  await expectError(
    await sendCall(f, "send_draft"),
    "google_unavailable",
    /Google could not complete/,
  );
  expect(await onceRows()).toEqual([]);
  expect((await callRows())[0]!.outcome).toBe("failed");
  expect(google.deletes).toEqual([]);
  expect(google.sends).toEqual([]);
});

it.each(sendCases)(
  "simultaneously arriving $name calls contend for the real D1 claim",
  async ({ name }) => {
    const f = await sendFixture(name);
    const values = await Promise.all([
      sendCall(f, name).then(answer),
      sendCall(f, name).then(answer),
    ]);
    expect(values.filter((v) => v.status !== "running" && !v.repeat_of)).toHaveLength(1);
    expect(google.sends).toHaveLength(1);
    expect(google.draftCreates.length + google.uploads.length).toBe(name === "send_draft" ? 0 : 1);
  },
);

it("ask then allow returns the same pending approval until Approve sends once", async () => {
  const f = await sendFixture("send_message", "ask");
  const pending = await answer(await sendCall(f));
  await setSend(f, "send_message", "allow");
  expect(await answer(await sendCall(f))).toEqual(pending);
  expect(google.sends).toEqual([]);
  expect(google.draftCreates).toEqual([]);
  expect(await onceRows()).toEqual([]);
  expect(await rows()).toHaveLength(1);
  expect((await callRows()).map((r) => r.outcome)).toEqual(["pending", "repeat"]);
  expect((await approve(f, pending.approval as string)).state.kind).toBe("succeeded");
  expect(google.sends).toHaveLength(1);
  expect(google.draftCreates).toHaveLength(1);
  expect((await answer(await sendCall(f))).repeat_of).toBe(isoSeconds(Date.now()));
  expect(google.sends).toHaveLength(1);
});

it.each(["send_message", "create_draft"] as const)(
  "keeps the exact recovery advice for an approved %s with a lost answer",
  async (name) => {
    const f =
      name === "send_message"
        ? await sendFixture("send_message", "ask")
        : await draftFixture("ask");
    const id = (await answer(name === "send_message" ? await sendCall(f) : await draftCall(f)))
      .approval as string;
    (name === "send_message" ? google.sendAnswers : google.draftCreateAnswers).push(() =>
      HttpResponse.error(),
    );
    const until = isoSeconds(Date.now() + WINDOW);
    const message =
      name === "send_message"
        ? `The server does not know whether this mail went out from ${PERSONAL}. Ask the owner to look in Sent. If it is not there, it may still be in Drafts, and the owner can send it from Gmail. Until ${until}, repeating this call does not send it again. Only if the owner says that it is in neither place, call again with duplicate: 2.`
        : `The server does not know whether the draft was created in ${PERSONAL}. Ask the owner to look in Drafts. Until ${until}, repeating this call does not create it again. If the owner says that the draft is missing, call again with duplicate: 2.`;
    const props = await approve(f, id);
    expect(props.state).toEqual({ kind: "unknown", message });
    expect(await get(f, id)).toEqual({
      status: "unknown",
      error: { code: "outcome_unknown", message },
    });
    expect((await page(f, id)).state).toEqual({ kind: "unknown", message });
    expect(textOf(await renderPage(props).text())).toContain(message);
    expect((await callRows())[0]!.outcome).toBeNull();
  },
);

it("treats a cleanup 404 as a draft that is already gone", async () => {
  const f = await sendFixture();
  google.sendAnswers.push(() => new Response(null, { status: 400 }));
  google.deleteAnswers.push(() => {
    google.storedDrafts.delete("draft-1");
    return new Response(null, { status: 404 });
  });
  await expectError(
    await sendCall(f),
    "message_not_sendable",
    /^Gmail refused this message.*valid\.$/,
  );
  expect(google.storedDrafts.has("draft-1")).toBe(false);
  expect(await onceRows()).toEqual([]);
  expect((await callRows())[0]!.outcome).toBe("refused");
});

it.each(sendCases)("$name releases a send refused as too large and can retry", async ({ name }) => {
  const f = await sendFixture(name);
  google.sendAnswers.push(() => new Response(null, { status: 413 }));
  await expectError(
    await sendCall(f, name),
    "message_too_large",
    "Gmail refused this message as too large.",
  );
  expect((await callRows())[0]!.outcome).toBe("refused");
  expect(await onceRows()).toEqual([]);
  expect(google.deletes).toEqual(name === "send_draft" ? [] : ["draft-1"]);
  await answer(await sendCall(f, name));
  expect(google.sends).toHaveLength(2);
});

it.each(["running", "unknown"])(
  "keeps recovery advice when Approve finds a send that is %s",
  async (state) => {
    const f = await sendFixture();
    const taking = deferred(),
      resume = deferred();
    const db = observeStatements(env.DB, async (sql) => {
      if (sql.startsWith("INSERT INTO once")) {
        taking.resolve();
        await resume.promise;
      }
    });
    const held =
      state === "running"
        ? hold(google.sendAnswers, Response.json({ id: "sent-1", threadId: "thread-1" }))
        : null;
    if (state === "unknown") google.sendAnswers.push(() => HttpResponse.error());
    const first = sendCall(f, "send_message", {}, testEnv({ DB: db }));
    try {
      await taking.promise;
      await setSend(f, "send_message", "ask");
      const id = (await answer(await sendCall(f))).approval as string;
      const shown = await digest(f, id);
      await setSend(f, "send_message", "allow");
      resume.resolve();
      if (held) await held.entered;
      else await expectError(await first, "outcome_unknown", /Ask the owner to look in Sent/);
      const message = `The server does not know whether this mail went out from ${PERSONAL}. Ask the owner to look in Sent. If it is not there, it may still be in Drafts, and the owner can send it from Gmail. Until ${isoSeconds(Date.now() + WINDOW)}, repeating this call does not send it again. Only if the owner says that it is in neither place, call again with duplicate: 2.`;
      const props = await decided(await post(f, id, "approve", { digest: shown }));
      expect(props.state).toEqual({ kind: "unknown", message });
      expect(await get(f, id)).toEqual({
        status: "unknown",
        error: { code: "outcome_unknown", message },
      });
      expect((await page(f, id)).state).toEqual({ kind: "unknown", message });
      expect(textOf(await renderPage(props).text())).toContain(message);
      const approval = (await row(id))!;
      expect((await callRows()).find((call) => call.id === approval.call_id)!.outcome).toBe(
        "repeat",
      );
      expect(google.sends).toHaveLength(1);
    } finally {
      resume.resolve();
      held?.release();
      if (held) await answer(await first);
    }
  },
);

it.each(["From", "Reply-To"])(
  "refuses a reply whose %s address was not shown whole",
  async (name) => {
    const f = await sendFixture("send_reply");
    serveFull(
      fullMessage({ [name]: "x".repeat(600 - " <sam@example.com>".length) + " <sam@example.com>" }),
    );
    await expectError(
      await sendCall(f, "send_reply"),
      "invalid_arguments",
      "The message field must be a message whose recipients the server can fill in. For this one, create a draft with create_draft, reply_to, and the recipients, and send it with send_draft.",
    );
    expect(google.draftCreates).toEqual([]);
    expect(google.sends).toEqual([]);
    expect(await onceRows()).toEqual([]);
  },
);

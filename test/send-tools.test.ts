import { expect, it, vi } from "vite-plus/test";
import { HttpResponse } from "msw";
import "./support/account-checks";
import { TOOLS } from "../src/mcp/tools";
import { WINDOW } from "../src/once/store";
import { isoSeconds } from "../src/approvals/model";
import { answer, approve, decided, get, post, rows } from "./support/approvals";
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
  "T5 T7 T8 O1: $name sends once and returns the stored sending IDs on repeat",
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
      expect(google.fullDraftRequests).toEqual([]);
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
  "T2: send_reply reuses the reply plan for $name",
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

it("T3: names message and the draft workaround when reply recipients cannot be filled", async () => {
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
}>)(
  "T1 T4 T5: refuses invalid $name input %# before Gmail or approval",
  async ({ name, args, field }) => {
    const f = await sendFixture(name, "ask");
    const traffic = googleTraffic().length;
    await expectError(
      await sendCall(f, name, args),
      "invalid_arguments",
      new RegExp(`The ${field} field must be`),
    );
    expect(googleTraffic().slice(traffic)).toEqual([]);
    expect(await onceRows()).toEqual([]);
    expect(await rows()).toEqual([]);
  },
);

it.each([
  "send_message",
  "send_reply",
  "forward_message",
  "send_draft",
  "create_draft",
  "list_labels",
])("T1: oversized denied %s is refused before parsing or binding an account", async (name) => {
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
  "T6: $name refuses undeclared recipients or actions before ask",
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

it.each([400, 404])(
  "T9 O3: a %s source read releases its call for a corrected retry",
  async (status) => {
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
  },
);

it.each([0, 400, 404])(
  "T9: an absent draft after send/read %s releases its call",
  async (readStatus) => {
    const f = await sendFixture("send_draft");
    google.sendAnswers.push(() => new Response(null, { status: readStatus ? 400 : 404 }));
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
    expect(google.fullDraftRequests).toHaveLength(readStatus ? 1 : 0);
    expect(await onceRows()).toEqual([]);
    google.fullDraftAnswers.clear();
    await answer(await sendCall(f, "send_draft"));
    expect(google.sends).toHaveLength(2);
    expect(google.deletes).toEqual([]);
  },
);

it.each(sendCases)(
  "T10 T11 T12: $name releases refused sends and only removes its staged draft",
  async ({ name }) => {
    const f = await sendFixture(name);
    for (const status of [400, 403, 429]) {
      google.sendAnswers.push(() => new Response(null, { status }));
      await expectError(
        await sendCall(f, name),
        status === 400 ? "message_not_sendable" : "google_unavailable",
        status === 400
          ? name === "send_draft"
            ? `Gmail refused to send draft "existing-draft" from ${PERSONAL}. A draft needs at least one recipient, and every address must be valid. The owner can complete it in Gmail.`
            : `Gmail refused this message from ${PERSONAL}. Check that every address is valid.`
          : /Google could not complete/,
      );
      expect(await onceRows()).toEqual([]);
      expect((await callRows()).at(-1)!.outcome).toBe(status === 400 ? "refused" : "failed");
    }
    expect(google.deletes).toHaveLength(name === "send_draft" ? 0 : 3);
    expect(google.fullDraftRequests).toHaveLength(name === "send_draft" ? 1 : 0);
    await answer(await sendCall(f, name));
    expect(google.sends).toHaveLength(4);
  },
);

it.each(["send_message", "send_reply", "forward_message"] as const)(
  "T10 O3: %s releases a refused staged draft",
  async (name) => {
    const f = await sendFixture(name);
    (name === "forward_message" ? google.uploadAnswers : google.draftCreateAnswers).push(
      () => new Response(null, { status: 400 }),
    );
    await expectError(
      await sendCall(f, name),
      "message_not_sendable",
      `Gmail refused this message from ${PERSONAL}. Check that every address is valid.`,
    );
    expect(google.sends).toEqual([]);
    expect(await onceRows()).toEqual([]);
    await answer(await sendCall(f, name));
    expect(google.sends).toHaveLength(1);
  },
);

it("T12: a failed cleanup preserves the sending refusal", async () => {
  const f = await sendFixture();
  google.sendAnswers.push(() => new Response(null, { status: 400 }));
  google.deleteAnswers.push(() => new Response(null, { status: 500 }));
  await expectError(await sendCall(f), "message_not_sendable", /Gmail refused this message/);
  expect(google.deletes).toEqual(["draft-1"]);
  expect(google.storedDrafts.has("draft-1")).toBe(true);
  expect(await onceRows()).toEqual([]);
});

it.each(["held", "concurrent"])("O2: %s identical calls send at most once", async (kind) => {
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
  "O5: %s sending outcome stays unknown with no cleanup or repeat send",
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

it("O6: a 404 sending a staged draft is unknown and cannot send a second copy", async () => {
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
  "O7 O10: $name defaults are identical and duplicate sends deliberately",
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
  "O8: unknown composed mail gives the exact safe advice for duplicate %s",
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
it("O8: an unknown existing draft never suggests duplicate", async () => {
  const f = await sendFixture("send_draft");
  google.sendAnswers.push(() => new Response(null, { status: 503 }));
  await expectError(
    await sendCall(f, "send_draft"),
    "outcome_unknown",
    `The server does not know whether draft "existing-draft" went out from ${PERSONAL}. Ask the owner to look in Sent. If the draft is still in Drafts, the owner can send it from Gmail. Until ${isoSeconds(Date.now() + WINDOW)}, repeating this call does not send it again.`,
  );
});

it("O11: ask deduplicates pending calls, Approve sends once, get_approval returns the send, and Reject sends nothing", async () => {
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

it("T13 O9: tools/list describes irreversible sends, fields, annotations and exact repeat instructions", async () => {
  const f = await sendFixture();
  for (const c of sendCases) await setSend(f, c.name, "allow");
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
    const entry = TOOLS.find((tool) => tool.name === c.name)!;
    expect(entry.kind === "account" && entry.group).toBe("Send");
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
  await permission(f);
});

it("T9 O4: an existing-draft diagnostic read failure is known after a refused send", async () => {
  const f = await sendFixture("send_draft");
  google.sendAnswers.push(() => new Response(null, { status: 400 }));
  google.fullDraftAnswers.set("existing-draft", () => new Response(null, { status: 500 }));
  await expectError(
    await sendCall(f, "send_draft"),
    "google_unavailable",
    /Google could not complete/,
  );
  expect(await onceRows()).toEqual([]);
  expect((await callRows())[0]!.outcome).toBe("failed");
  expect(google.deletes).toEqual([]);
});

it.each(sendCases)(
  "O2: simultaneously arriving $name calls contend for the real D1 claim",
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

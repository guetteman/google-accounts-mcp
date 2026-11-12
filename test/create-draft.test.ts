import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { expect, it, vi } from "vite-plus/test";
import "./support/account-checks";
import { MAX_SUBJECT, parseMailbox } from "../src/google/mail";
import { CALL_DEADLINE } from "../src/mcp/call";
import { answer, approve, page, rows } from "./support/approvals";
import {
  callRows,
  expectError,
  PERSONAL,
  googleTraffic,
  permission,
  toolCall,
} from "./support/permissions";
import {
  draftCall,
  draftFixture,
  decodedMail,
  onceRows,
  replyCases,
  serveMessage,
  setDraft,
  SOURCE,
  THREAD,
} from "./support/draft";
import { google } from "./support/google";
import { observeStatements } from "./support/db";
import { callWorker, ORIGIN, testEnv } from "./support/worker";
import { rpcResult } from "./support/oauth";

it("creates one draft with the recipients, subject and unchanged plain text body", async () => {
  const f = await draftFixture();
  const body = "Hola José 🙂\n" + "long ".repeat(300);
  expect(
    await answer(
      await draftCall(f, {
        to: ["Sam <sam@example.com>"],
        cc: ["kim@example.com"],
        bcc: ["jo@example.com"],
        subject: "Plans",
        body,
      }),
    ),
  ).toEqual({ account: PERSONAL, draft: "draft-1", message: "message-1", thread: "thread-1" });
  expect(google.draftCreates).toEqual([
    expect.objectContaining({
      url: "https://gmail.googleapis.com/gmail/v1/users/me/drafts",
      method: "POST",
      redirect: "manual",
      contentType: "application/json",
    }),
  ]);
  const mail = decodedMail();
  expect(Object.keys(mail.request.message)).toEqual(["raw"]);
  expect(mail.headers).toEqual({
    To: "Sam <sam@example.com>",
    Cc: "kim@example.com",
    Bcc: "jo@example.com",
    Subject: "Plans",
    "MIME-Version": "1.0",
    "Content-Type": "text/plain; charset=UTF-8",
    "Content-Transfer-Encoding": "base64",
  });
  expect(mail.body).toBe(body);
  expect((await callRows()).map((row) => row.outcome)).toEqual(["success"]);
});

it.each(["Lunch", "rE: Lunch"])(
  "threads the reply to subject %s with safe reply headers",
  async (subject) => {
    const f = await draftFixture();
    serveMessage({ Subject: subject });
    await answer(await draftCall(f, { reply_to: SOURCE }));
    const mail = decodedMail();
    expect(mail.request.message.threadId).toBe(THREAD);
    expect(mail.headers).toMatchObject({
      Subject: /^re:/i.test(subject) ? subject : "Re: Lunch",
      "In-Reply-To": "<source@example.com>",
      References: "<earlier@example.com> <source@example.com>",
    });
    expect(mail.body).toBe("Hello");
    const request = new URL(google.messageRequests[0]!);
    expect(request.pathname).toBe(`/gmail/v1/users/me/messages/${SOURCE}`);
    expect(request.searchParams.get("format")).toBe("metadata");
    expect(request.searchParams.getAll("metadataHeaders")).toEqual([
      "From",
      "Reply-To",
      "To",
      "Cc",
      "Subject",
      "Message-ID",
      "References",
    ]);
  },
);

it.each(replyCases)("fills exactly the recipients for $name", async (test) => {
  const f = await draftFixture();
  serveMessage(test.headers);
  await answer(await draftCall(f, { reply_to: SOURCE, ...test.args }));
  const mail = decodedMail();
  expect(mail.headers.To).toBe(test.to);
  expect(mail.headers.Cc).toBe(test.cc);
  expect(mail.headers.Bcc).toBe("bcc" in test ? test.bcc : undefined);
});

it.each([
  [{ reply_all: true }, "reply_all"],
  ...["to", "cc", "bcc"].map((field) => [
    { reply_to: SOURCE, reply_all: true, [field]: ["sam@example.com"] },
    "reply_all",
  ]),
  [{ reply_to: SOURCE, subject: "Subject" }, "subject"],
  ...["to", "cc", "bcc"].map((field) => [{ [field]: ["not a mailbox"] }, field]),
  ...["\n", "\r", "\t", "\0", "\x1f", "\x7f"].map((value) => [
    { subject: `Hi${value}There` },
    "subject",
  ]),
  ...["id/path", "id?query", "a.b", "a+b", "é", "id\n", "x".repeat(65), ""].map((reply_to) => [
    { reply_to },
    "reply_to",
  ]),
  [{ duplicate: 1 }, "duplicate"],
  [{ duplicate: 2.5 }, "duplicate"],
  [{ duplicate: 101 }, "duplicate"],
] as [Record<string, unknown>, string][])(
  "rejects invalid input %# before taking a row or asking",
  async (args, field) => {
    const f = await draftFixture("ask");
    const before = googleTraffic().length;
    await expectError(
      await draftCall(f, args),
      "invalid_arguments",
      new RegExp(`The ${field} field must be`),
    );
    expect(await rows()).toEqual([]);
    expect(await onceRows()).toEqual([]);
    expect(googleTraffic().slice(before)).toEqual([]);
  },
);

it.each([400, 404])(
  "releases a missing reply message after %s so a corrected retry can run",
  async (status) => {
    const f = await draftFixture();
    google.messageAnswers.set(SOURCE, () => new Response(null, { status }));
    await expectError(
      await draftCall(f, { reply_to: SOURCE }),
      "not_found",
      `No message "${SOURCE}" exists in ${PERSONAL}. A message ID works only in the account that returned it.`,
    );
    expect(await onceRows()).toEqual([]);
    expect(google.draftCreates).toEqual([]);
    serveMessage();
    await answer(await draftCall(f, { reply_to: SOURCE }));
    expect(google.draftCreates).toHaveLength(1);
  },
);

it("checks missing access before taking a row and succeeds after access is restored", async () => {
  const f = await draftFixture();
  await env.DB.prepare("UPDATE accounts SET scopes = '[]' WHERE id = ?").bind(f.personal.id).run();
  await expectError(await draftCall(f), "account_missing_access", /Google did not grant/);
  expect(await onceRows()).toEqual([]);
  await env.DB.prepare("UPDATE accounts SET scopes = ? WHERE id = ?")
    .bind(f.personal.scopes, f.personal.id)
    .run();
  await answer(await draftCall(f));
  expect(google.draftCreates).toHaveLength(1);
});

it("releases a deadline failure before the answered message is read", async () => {
  const f = await draftFixture();
  serveMessage();
  const at = Date.now();
  const db = observeStatements(
    env.DB,
    () => {},
    (sql) => {
      if (sql.startsWith("INSERT INTO once"))
        vi.mocked(Date.now).mockReturnValue(at + CALL_DEADLINE);
    },
  );
  await expectError(
    await draftCall(f, { reply_to: SOURCE }, testEnv({ DB: db })),
    "google_unavailable",
    /Google could not complete/,
  );
  expect(google.draftCreates).toEqual([]);
  expect(google.messageRequests).toEqual([]);
  expect(await onceRows()).toEqual([]);
  vi.mocked(Date.now).mockReturnValue(at);
  await answer(await draftCall(f, { reply_to: SOURCE }));
  expect(google.draftCreates).toHaveLength(1);
});

it("releases a known deadline failure after reading and before the creating request", async () => {
  const f = await draftFixture();
  const at = Date.now();
  serveMessage();
  const metadata = google.messageAnswers.get(SOURCE)!;
  google.messageAnswers.set(SOURCE, (request) => {
    const response = metadata(request);
    vi.mocked(Date.now).mockReturnValue(at + CALL_DEADLINE);
    return response;
  });
  await expectError(
    await draftCall(f, { reply_to: SOURCE }),
    "google_unavailable",
    /Google could not complete/,
  );
  expect(await onceRows()).toEqual([]);
  vi.mocked(Date.now).mockReturnValue(at);
  serveMessage();
  await answer(await draftCall(f, { reply_to: SOURCE }));
  expect(google.messageRequests).toHaveLength(2);
  expect(google.draftCreates).toHaveLength(1);
});

it.each([
  { name: "empty To group", headers: { To: "undisclosed-recipients:;" } },
  { name: "unused long To", headers: { To: "x".repeat(2001) } },
])("ignores $name in a plain reply", async ({ headers }) => {
  const f = await draftFixture();
  serveMessage(headers);
  await answer(await draftCall(f, { reply_to: SOURCE }));
  expect(decodedMail().headers.To).toBe("Sam <sam@example.com>");
});

it.each([
  { name: "invalid From", headers: { From: "not a mailbox" } },
  { name: "long From", headers: { From: "x".repeat(2001) + " <sam@example.com>" } },
  { name: "long Reply-To", headers: { "Reply-To": "x".repeat(2001) + " <sam@example.com>" } },
])("asks for given recipients for $name and keeps no row", async ({ headers }) => {
  const f = await draftFixture();
  serveMessage(headers);
  await expectError(
    await draftCall(f, { reply_to: SOURCE }),
    "invalid_arguments",
    "The to field must be given by you for this reply, because the server could not fill in the recipients of the answered message.",
  );
  expect(await onceRows()).toEqual([]);
  expect(google.draftCreates).toEqual([]);
});

it("cuts the reply subject at a code point and shows the exact cut subject on the approval", async () => {
  const f = await draftFixture("ask");
  serveMessage({ Subject: "🙂".repeat(600) });
  const pending = await answer(await draftCall(f, { reply_to: SOURCE }));
  const id = pending.approval as string;
  const shown = await page(f, id);
  const subject = shown.request.values.find((value) => value.name === "Subject")!.text;
  expect(subject).toBe("Re: " + "🙂".repeat(496) + "…");
  expect(subject.length).toBeLessThanOrEqual(MAX_SUBJECT);
  await approve(f, id);
  expect(decodedMail().headers.Subject).toBe(subject);
});

it.each(["To", "Cc"])("refuses filled-in %s longer than 2000 characters", async (field) => {
  const f = await draftFixture();
  const addresses = Array.from(
    { length: 180 },
    (_, i) => `A<r${String(i).padStart(3, "0")}@x>`,
  ).join(",");
  expect(addresses.length).toBeLessThan(2000);
  serveMessage(
    field === "To" ? { From: addresses } : { To: addresses, Cc: "Extra <extra@example.com>" },
  );
  await expectError(
    await draftCall(f, { reply_to: SOURCE, reply_all: field === "Cc" }),
    "invalid_arguments",
    /The to field must be given by you for this reply/,
  );
  expect(await onceRows()).toEqual([]);
  expect(google.draftCreates).toEqual([]);
});

it("bounds filled recipients after RFC 2047 encoding, even when the source header fits", async () => {
  const f = await draftFixture();
  const from = `${"🙂".repeat(400)} <sam@example.com>`;
  expect(from.length).toBeLessThanOrEqual(998);
  expect(parseMailbox(from)).not.toBeNull();
  serveMessage({ From: from });
  await expectError(
    await draftCall(f, { reply_to: SOURCE }),
    "invalid_arguments",
    /The to field must be given by you for this reply/,
  );
  expect(google.draftCreates).toEqual([]);
  expect(await onceRows()).toEqual([]);
});

it.each(["b", "<x@example.com>"])(
  "rejects oversized arguments before parsing a recipient ending in %s even when denied",
  async (end) => {
    const f = await draftFixture();
    await setDraft(f, "deny");
    const text = "a" + " ".repeat(300_000 - end.length - 1) + end;
    await expectError(
      await draftCall(f, { to: [text] }),
      "invalid_arguments",
      "The arguments are too large. The limit is 256 KB.",
    );
    expect(await rows()).toEqual([]);
    expect(await onceRows()).toEqual([]);
    expect(google.draftCreates).toEqual([]);
  },
);

it("rejects an overlong address with ask before creating an approval", async () => {
  const f = await draftFixture("ask");
  await expectError(
    await draftCall(f, { to: ["a".repeat(1000) + "@example.com"] }),
    "invalid_arguments",
    /The to field must be/,
  );
  expect(await rows()).toEqual([]);
  expect(await onceRows()).toEqual([]);
  expect(google.draftCreates).toEqual([]);
});

it.each([false, true])(
  "keeps the last reference IDs, with oversized source %s",
  async (oversized) => {
    const f = await draftFixture();
    const ids = Array.from({ length: oversized ? 500 : 60 }, (_, i) => `<prior-${i}@example.com>`);
    serveMessage({ References: ids.join(" ") });
    await answer(await draftCall(f, { reply_to: SOURCE }));
    const reference = decodedMail().headers.References!;
    expect(reference.length + "References: ".length).toBeLessThanOrEqual(900);
    expect(reference.endsWith("<source@example.com>")).toBe(true);
    if (oversized) expect(reference).toBe("<source@example.com>");
    else {
      expect(reference).not.toContain("<prior-0@example.com>");
      expect(reference).toContain("<prior-59@example.com>");
    }
  },
);

it("prevents sender-controlled header injection and discards invalid message ID tokens", async () => {
  const f = await draftFixture();
  serveMessage({
    Subject: "Hi\r\nBcc: mallory@example.com",
    "Message-ID": "<source\r\n@example.com>",
    References: "junk <good@example.com> <bad id>",
  });
  await answer(await draftCall(f, { reply_to: SOURCE }));
  const mail = decodedMail();
  expect(mail.entries.map(([name]) => name)).toEqual([
    "To",
    "Subject",
    "MIME-Version",
    "Content-Type",
    "Content-Transfer-Encoding",
  ]);
  expect(mail.headers.Subject).toBe("Re: Hi  Bcc: mallory@example.com");
  expect(mail.headers.Bcc).toBeUndefined();
  serveMessage({
    Subject: "Safe",
    References: "junk <good@example.com> <bad id> <other@example.com>",
  });
  await answer(await draftCall(f, { reply_to: SOURCE, duplicate: 2 }));
  const clean = decodedMail();
  expect(clean.headers["In-Reply-To"]).toBe("<source@example.com>");
  expect(clean.headers.References).toBe(
    "<good@example.com> <other@example.com> <source@example.com>",
  );
});

it("announces each tool's annotations, duplicate schema, and the exact repeating paragraph", async () => {
  const f = await draftFixture();
  for (const name of ["list_labels", "search_threads", "read_thread"])
    await permission(f, f.personal, true, name);
  const listed = await rpcResult(await f.mcp.call());
  const tools = listed.tools as Array<{
    name: string;
    annotations: unknown;
    description: string;
    inputSchema: { properties: Record<string, unknown> };
  }>;
  expect(tools.map((tool) => tool.name)).toEqual([
    "list_accounts",
    "list_labels",
    "search_threads",
    "read_thread",
    "create_draft",
    "get_approval",
  ]);
  for (const tool of tools.filter((tool) => tool.name !== "create_draft"))
    expect(tool.annotations).toEqual({ readOnlyHint: true });
  const draft = tools.find((tool) => tool.name === "create_draft")!;
  expect(draft.annotations).toEqual({
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  });
  expect(draft.inputSchema.properties.duplicate).toMatchObject({
    type: "integer",
    minimum: 2,
    maximum: 100,
  });
  expect(draft.description).toContain(
    "Repeating: a call with the same arguments as a call of the last 7 days is the same call. It never creates a second draft. It returns the first call's result with `repeat_of`, or its pending approval. So when you get no answer or an error that says to try again, call again with exactly the same arguments. Copy them; do not reword the text, because changed text is a new draft. When the answer says that the outcome is unknown, do not try another wording: ask the owner to look in Gmail. To create one more draft with the same content on purpose, add `duplicate: 2` (then 3).",
  );
  await setDraft(f, "ask");
  expect((await answer(await draftCall(f))).status).toBe("pending");
});

it("registers successful and failed tools/call work with waitUntil as resolving promises", async () => {
  const f = await draftFixture();
  for (const [args, isError] of [
    [{ account: PERSONAL, body: "Hello" }, false],
    [{ account: PERSONAL, body: 1 }, true],
  ] as const) {
    const ctx = createExecutionContext();
    const wait = vi.spyOn(ctx, "waitUntil");
    const response = await callWorker(
      new Request(`${ORIGIN}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${f.mcp.tokens!.access_token}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": "2025-11-25",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "create_draft", arguments: args },
        }),
      }),
      testEnv(),
      ctx,
    );
    expect((await rpcResult(response)).isError === true).toBe(isError);
    expect(wait).toHaveBeenCalledTimes(1);
    await expect(wait.mock.calls[0]![0]).resolves.toBeUndefined();
  }
});

it.each(["allow", "ask"] as const)(
  "rejects undeclared fields with %s before any row or approval exists",
  async (setting) => {
    const f = await draftFixture(setting);
    const before = googleTraffic().length;
    for (const field of ["attachments", "constructor"])
      await expectError(
        await draftCall(f, { [field]: ["must not be silently discarded"] }),
        "invalid_arguments",
        `The ${field} field must be left out: this tool has no such field.`,
      );
    expect(await onceRows()).toEqual([]);
    expect(await rows()).toEqual([]);
    expect(googleTraffic().slice(before)).toEqual([]);
    await permission(f, f.personal, true, "list_labels");
    expect(
      await answer(
        await toolCall(f.mcp, "list_labels", {
          account: PERSONAL,
          attachments: ["ignored by a reading tool"],
        }),
      ),
    ).toMatchObject({ account: PERSONAL, labels: expect.any(Array) });
  },
);

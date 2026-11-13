import { testEnv } from "./support/worker";
import { ToolFailure } from "../src/mcp/failures";
import "./support/account-checks";
import { Buffer } from "node:buffer";
import { Effect, Result } from "effect";
import { expect, it, vi } from "vite-plus/test";
import {
  attaching,
  copy,
  upload,
  uploads,
  attachCall,
  input,
  setTool,
  filePart,
  serveAttachment,
  expectMail,
  noWrites,
  watchedFiles,
} from "./support/uploads";
import { accountTraffic, google, deferred } from "./support/google";
import { CONTENT, MESSAGE } from "./support/attachment";
import { answer, rows } from "./support/approvals";
import { callRows, expectError, NORTHWIND, PERSONAL, toolCall } from "./support/permissions";
import { onceRows, SOURCE, THREAD, serveMessage } from "./support/draft";
import { fixtureOpen } from "./support/accounts";
import { mime, never, leftoverMessage } from "./support/send";
import { sourceRead } from "../src/mcp/call";

it.each(["create_draft", "send_message", "send_reply"] as const)(
  "composes the entire %s with ordered copies and a local file using the right accounts",
  async (name) => {
    const f = await attaching(name);
    await setTool(f, "get_attachment", "allow", f.northwind);
    const uploaded = await upload(f);
    const raw = serveAttachment();
    const own = await fixtureOpen(`${f.personal.id}:access`, f.personal.access_token!);
    const source = await fixtureOpen(`${f.northwind.id}:access`, f.northwind.access_token!);
    google.accountMessages.set(`Bearer ${source}:${MESSAGE}`, raw);
    const referenced = {
      ...filePart("image/png", "photo.png"),
      body: { size: 4, attachmentId: "photo" },
    };
    const referencedRaw = serveAttachment(referenced);
    google.accountMessages.set(`Bearer ${source}:second-file`, {
      ...referencedRaw,
      id: "second-file",
    });
    google.attachmentAnswers.set("photo", () => Response.json({ data: "AP8KQQ" }));
    serveMessage();
    const replyRaw = await (
      await google.messageAnswers.get(SOURCE)!({ signal: new AbortController().signal })
    ).json<object>();
    google.accountMessages.set(`Bearer ${own}:${SOURCE}`, replyRaw);
    const attachments = [copy, { ...copy, message: "second-file" }, { upload: uploaded.upload }];
    const result = await answer(
      await attachCall(f, attachments, name === "send_reply" ? { message: SOURCE } : {}, name),
    );
    expect(Object.keys(result).sort()).toEqual(
      name === "create_draft"
        ? ["account", "draft", "message", "thread"]
        : ["account", "message", "thread"],
    );
    const headers =
      name === "send_reply"
        ? {
            To: "Sam <sam@example.com>",
            Cc: undefined,
            Bcc: undefined,
            Subject: "Re: Lunch",
            "In-Reply-To": "<source@example.com>",
            References: "<earlier@example.com> <source@example.com>",
          }
        : {};
    const mail = expectMail({
      headers: headers,
      files: [
        { filename: "menu.pdf", type: "application/pdf", bytes: CONTENT },
        { filename: "photo.png", type: "image/png", bytes: new Uint8Array([0, 255, 10, 65]) },
        { filename: "local.pdf", type: "application/pdf", bytes: new Uint8Array([0, 255, 10, 65]) },
      ],
    });
    if (name === "send_reply") {
      expect(mail.headers.Cc).toBeUndefined();
      expect(mail.headers.Bcc).toBeUndefined();
    }
    expect(google.uploads[0]!.metadata).toEqual(
      name === "send_reply" ? { message: { threadId: THREAD } } : {},
    );
    expect(
      accountTraffic.map(({ method, url }) => [method, new URL(url).pathname.split("/me/")[1]]),
    ).toEqual([
      ...(name === "send_reply" ? [["GET", `messages/${SOURCE}`]] : []),
      ["GET", `messages/${MESSAGE}`],
      ["GET", "messages/second-file"],
      ["GET", "messages/second-file/attachments/photo"],
      ["POST", "drafts"],
      ...(name === "create_draft" ? [] : [["POST", "drafts/send"]]),
    ]);
    for (const request of accountTraffic)
      expect(request.authorization).toBe(
        `Bearer ${request.url.includes(`/messages/${MESSAGE}`) || request.url.includes("/messages/second-file") ? source : own}`,
      );
  },
);
it("refuses a source write before it reaches the network", async () => {
  let writes = 0;
  const read = sourceRead((build) =>
    Effect.try({
      try: () => {
        build("fake-token", new AbortController().signal);
        writes++;
        return new Response();
      },
      catch: (error) => error as ToolFailure,
    }),
  );
  const result = await Effect.runPromise(
    Effect.result(
      read(
        () =>
          new Request("https://gmail.googleapis.com/gmail/v1/users/me/drafts", { method: "POST" }),
      ),
    ),
  );
  expect(Result.isFailure(result) && result.failure.code).toBe("google_unavailable");
  expect(writes).toBe(0);
});
it("treats an empty attachment list as the original text draft and the same identity", async () => {
  const f = await attaching("create_draft");
  const first = await answer(
    await toolCall(f.mcp, "create_draft", { account: PERSONAL, ...input }),
  );
  const repeated = await answer(await attachCall(f, [], {}, "create_draft"));
  expect(repeated).toMatchObject({ ...first, repeat_of: expect.any(String) });
  expect(google.draftCreates).toHaveLength(1);
  expect(google.uploads).toEqual([]);
});
it.each([
  Array.from({ length: 11 }, () => copy),
  [{ ...copy, upload: crypto.randomUUID() }],
  [{ ...copy, extra: true }],
  [{ upload: "not-a-uuid" }],
  [
    { upload: "11111111-1111-4111-8111-111111111111" },
    { upload: "11111111-1111-4111-8111-111111111111" },
  ],
  [{ ...copy, attachment: "bad" }],
  [{ ...copy, message: "bad message" }],
  [null],
  "files",
])("rejects malformed attachments before creating state (%#)", async (bad) => {
  const f = await attaching("create_draft", "ask");
  await expectError(
    await attachCall(f, bad, {}, "create_draft"),
    "invalid_arguments",
    /The attachments field must be/,
  );
  expect(await onceRows()).toEqual([]);
  expect(await rows()).toEqual([]);
  noWrites();
});
it("copies a file above the download result limit without returning its bytes", async () => {
  const f = await attaching("create_draft");
  await setTool(f, "get_attachment", "allow", f.northwind);
  const content = new Uint8Array(13_000_000).fill(137);
  serveAttachment(filePart("application/pdf", "large.pdf", content));
  const out = await answer(await attachCall(f, [copy], {}, "create_draft"));
  expect(Object.keys(out).sort()).toEqual(["account", "draft", "message", "thread"]);
  const actual = new Uint8Array(mime(google.uploads[0]!.message).parts[1]!.data);
  expect(actual.byteLength).toBe(content.byteLength);
  expect(Buffer.from(await crypto.subtle.digest("SHA-256", actual)).toString("hex")).toBe(
    Buffer.from(await crypto.subtle.digest("SHA-256", content)).toString("hex"),
  );
});
it.each(["sizes", "actual", "413"])(
  "refuses a copy over the message limit from %s and creates nothing",
  async (where) => {
    const f = await attaching();
    await setTool(f, "get_attachment", "allow", f.northwind);
    serveAttachment({
      ...filePart(),
      body: { size: where === "sizes" ? 25_000_001 : 1, attachmentId: "file" },
    });
    google.attachmentAnswers.set("file", () =>
      Response.json({
        data: where === "actual" ? Buffer.alloc(25_000_001).toString("base64url") : "AA",
      }),
    );
    if (where === "413") google.uploadAnswers.push(() => new Response(null, { status: 413 }));
    const local = where === "sizes" ? await upload(f) : null;
    const watched = watchedFiles();
    await expectError(
      await attachCall(
        f,
        [copy, ...(local ? [{ upload: local.upload }] : [])],
        {},
        "send_message",
        testEnv({ FILES_KV: watched.files }),
      ),
      "message_too_large",
      where === "413"
        ? "Gmail refused this message as too large."
        : /This message would have .* bytes of attachments and text. The limit is 25,000,000 bytes./,
    );
    expect(google.sends).toEqual([]);
    if (where === "sizes") {
      expect(watched.reads).toEqual([]);
      expect(google.attachmentRequests).toEqual([]);
      expect(google.uploads).toEqual([]);
    }
    expect(await onceRows()).toEqual([]);
    expect((await callRows()).at(-1)!.outcome).toBe("refused");
  },
);
it.each(["500", "invalid-base64"])(
  "never writes a partial message after attachment bytes fail with %s",
  async (failure) => {
    const f = await attaching();
    await setTool(f, "get_attachment", "allow", f.northwind);
    serveAttachment({ ...filePart(), body: { size: 4, attachmentId: "bad" } });
    const first = serveAttachment({ ...filePart(), partId: "1" });
    google.messageAnswers.set("first-copy", () => Response.json(first));
    const third = serveAttachment({ ...filePart(), partId: "3" });
    google.messageAnswers.set("third-copy", () => Response.json(third));
    serveAttachment({ ...filePart(), body: { size: 4, attachmentId: "bad" } });
    const items = [
      { ...copy, message: "first-copy", attachment: "1" },
      copy,
      { ...copy, message: "third-copy", attachment: "3" },
    ];
    google.attachmentAnswers.set("bad", () =>
      failure === "500" ? new Response(null, { status: 500 }) : Response.json({ data: "***" }),
    );
    await expectError(
      await attachCall(f, items),
      "google_unavailable",
      `Google could not complete the request for ${NORTHWIND}. Try again later.`,
    );
    noWrites();
    serveAttachment();
    await answer(await attachCall(f, items));
    expectMail({
      files: Array.from({ length: 3 }, () => ({
        filename: "menu.pdf",
        type: "application/pdf",
        bytes: CONTENT,
      })),
    });
  },
);
it.each(["send_message", "create_draft"] as const)(
  "handles an unanswered %s upload with its own recovery rule",
  async (name) => {
    const f = await attaching(name);
    const file = await upload(f);
    const entered = deferred();
    google.uploadAnswers.push((request) => {
      entered.resolve();
      return never(request);
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const work = attachCall(f, [{ upload: file.upload }], {}, name);
    await entered.promise;
    await vi.advanceTimersByTimeAsync(10_000);
    await expectError(
      await work,
      name === "create_draft" ? "outcome_unknown" : "google_unavailable",
      name === "create_draft" ? /duplicate: 2 and a new upload of each file\.$/ : leftoverMessage,
    );
    expect(google.sends).toEqual([]);
    if (name === "create_draft") expect(await uploads()).toEqual([]);
    const repeat = await attachCall(f, [{ upload: file.upload }], {}, name);
    if (name === "create_draft") {
      await expectError(repeat, "outcome_unknown", /new upload of each file/);
      expect(google.uploads).toHaveLength(1);
    } else {
      await answer(repeat);
      expect(google.sends).toHaveLength(1);
    }
  },
);

it("advertises only the attaching schemas with their complete file instructions", async () => {
  const f = await attaching();
  await setTool(f, "create_draft", "allow");
  await setTool(f, "send_reply", "allow");
  const { rpcResult } = await import("./support/oauth");
  const listed = (await rpcResult(await f.mcp.call())).tools as Array<{
    name: string;
    description: string;
    inputSchema: { properties: Record<string, { maxItems?: number }> };
  }>;
  for (const name of ["create_draft", "send_message", "send_reply"]) {
    const entry = listed.find((entry) => entry.name === name)!;
    expect(entry.inputSchema.properties.attachments).toHaveProperty("maxItems", 10);
    expect(entry.description).toContain("`attachments` is an optional list of at most 10 files.");
    expect(entry.description).toContain("read_thread listed");
    expect(entry.description).toContain("get_attachment on that account");
    expect(entry.description).toContain("`upload` ID that the link of create_upload_link answered");
    expect(entry.description).toContain("An upload goes into one message");
    expect(entry.description).toContain("attachments and the text together can have at most 25 MB");
  }
});

it.each(["copy", "upload"])(
  "gives the exact repeat and unknown instructions for a %s",
  async (kind) => {
    const f = await attaching();
    await setTool(f, "get_attachment", "allow", f.northwind);
    const files = kind === "copy" ? [copy] : [{ upload: (await upload(f)).upload }];
    await answer(await attachCall(f, files));
    const again = await answer(await attachCall(f, files));
    const at = "2030-11-09T12:00:00Z";
    const ending = kind === "upload" ? " and a new upload of each file" : "";
    expect(again.note).toBe(
      `This call already ran at ${at}. Nothing was created or sent again. This is its result. To make one more on purpose, call again with duplicate: 2${ending}.`,
    );
    const next = kind === "copy" ? files : [{ upload: (await upload(f)).upload }];
    const { HttpResponse } = await import("msw");
    google.sendAnswers.push(() => HttpResponse.error());
    const unknown = `The server does not know whether this mail went out from ${PERSONAL}. Ask the owner to look in Sent. If it is not there, it may still be in Drafts, and the owner can send it from Gmail. Until 2030-11-16T12:00:00Z, repeating this call does not send it again. Only if the owner says that it is in neither place, call again with duplicate: 2${ending}.`;
    await expectError(
      await attachCall(f, next, { body: "Unconfirmed" }),
      "outcome_unknown",
      unknown,
    );
    await expectError(
      await attachCall(f, next, { body: "Unconfirmed" }),
      "outcome_unknown",
      unknown,
    );
  },
);

it.each(["send_message", "create_draft"] as const)(
  "keeps uploads after an uncertain copy read before %s starts writing",
  async (name) => {
    const f = await attaching(name);
    await setTool(f, "get_attachment", "allow", f.northwind);
    const local = await upload(f);
    const { HttpResponse } = await import("msw");
    google.messageAnswers.set(MESSAGE, () => HttpResponse.error());
    await expectError(
      await attachCall(f, [copy, { upload: local.upload }], {}, name),
      "google_unavailable",
      `Google could not complete the request for ${NORTHWIND}. Try again later.`,
    );
    noWrites();
    expect(await onceRows()).toEqual([]);
    serveAttachment();
    await answer(await attachCall(f, [copy, { upload: local.upload }], {}, name));
    expect(google.uploads).toHaveLength(1);
  },
);

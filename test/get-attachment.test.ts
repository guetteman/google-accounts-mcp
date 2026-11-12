import { Buffer } from "node:buffer";
import { expect, it } from "vite-plus/test";
import "./support/account-checks";
import type { FramePage } from "../src/pages/page";
import type { ThreadResult } from "../src/google/thread";
import { answer } from "./support/approvals";
import { google, MESSAGES_URL } from "./support/google";
import { rpcResult, codeClient, clients } from "./support/oauth";
import {
  callRows,
  googleTraffic,
  permission,
  PERSONAL,
  toolCall,
  unavailableMessage,
} from "./support/permissions";
import { message, part, read, serveThread, tree } from "./support/thread";
import {
  allowedAttachment,
  blocks,
  CONTENT,
  download,
  fileError,
  filePart,
  MESSAGE,
  metadata,
  resourceBytes,
  serveAttachment,
} from "./support/attachment";

it("returns bounded metadata in order and exact PDF, PNG, text and binary resources to Claude Code", async () => {
  const f = await allowedAttachment();
  for (const [type, filename] of [
    ["application/pdf", "menu.pdf"],
    ["application/pdf", "a b/#%ñ.pdf"],
    ["image/png", ""],
    ["text/plain", "n".repeat(300)],
    ["application/octet-stream", "binary.dat"],
    ["x".repeat(150), "long-type"],
  ]) {
    const file = filePart(type, filename);
    // A nameless non-body part needs an attachmentId to be listed by read_thread.
    serveAttachment({ ...file, body: { ...file.body, attachmentId: "current-id" } });
    const out = await blocks(await download(f, { account: " Alex.Personal@Example.com " }));
    expect(metadata(out)).toEqual({
      account: PERSONAL,
      message: MESSAGE,
      attachment: "2",
      filename: filename!.length > 200 ? filename!.slice(0, 199) + "…" : filename,
      type: type!.length > 100 ? type!.slice(0, 99) + "…" : type,
      size: CONTENT.length,
    });
    expect(Object.keys(metadata(out))).toEqual([
      "account",
      "message",
      "attachment",
      "filename",
      "type",
      "size",
    ]);
    expect(out.content[1]).toMatchObject({
      type: "resource",
      resource: {
        uri: `attachment://file/${encodeURIComponent(filename!.length > 200 ? filename!.slice(0, 199) + "…" : filename!)}`,
        mimeType: metadata(out).type,
      },
    });
    expect(resourceBytes(out)).toEqual(CONTENT);
  }
  expect(google.messageRequests).toEqual(Array(6).fill(`${MESSAGES_URL}/${MESSAGE}?format=full`));
  expect(google.attachmentRequests).toEqual([]);
});

it("returns exact bytes when Gmail supplies an unpaired surrogate in the filename", async () => {
  const f = await allowedAttachment();
  serveAttachment(filePart("application/pdf", "file-" + String.fromCharCode(0xd83d) + ".pdf"));
  const out = await blocks(await download(f));
  expect(out.isError).toBeUndefined();
  const filename = metadata(out).filename as string;
  expect(filename.split("").map((char) => char.charCodeAt(0))).toEqual([
    102, 105, 108, 101, 45, 0xd83d, 46, 112, 100, 102,
  ]);
  expect(out.content[1]).toMatchObject({
    type: "resource",
    resource: {
      uri: "attachment://file/file-%EF%BF%BD.pdf",
    },
  });
  expect(resourceBytes(out)).toEqual(CONTENT);
});

it("downloads every listed position, omitted attachments, and child 0 of a named multipart root", async () => {
  const f = await allowedAttachment();
  await permission(f, f.personal, true, "read_thread");
  const files = [
    filePart(),
    { ...filePart("image/png", ""), partId: "0", body: { size: 8, attachmentId: "inline" } },
    filePart("text/plain", "notes.txt"),
  ];
  const raw = serveAttachment({
    ...tree(
      "multipart/related",
      files.map((p, i) => ({ ...p, partId: `2.${i}` })),
    ),
    partId: "2",
  });
  serveThread([raw]);
  google.attachmentAnswers.set("inline", () =>
    Response.json({ size: 8, data: Buffer.from(CONTENT).toString("base64url") }),
  );
  const listed = (await answer(await read(f))) as unknown as ThreadResult;
  expect(listed.messages[0]!.attachments.map((a) => a.attachment)).toEqual(["2.0", "2.1", "2.2"]);
  for (const attachment of listed.messages[0]!.attachments) {
    const out = await blocks(await download(f, { attachment: attachment.attachment }));
    expect(metadata(out)).toEqual({ account: PERSONAL, message: MESSAGE, ...attachment });
    expect(resourceBytes(out)).toEqual(CONTENT);
  }
  await fileError(await download(f, { attachment: "1" }), "not_found", /No attachment "1" exists/);
  const bytesBefore = google.attachmentRequests.length;
  google.attachmentAnswers.set("body-only", () => Response.json({ size: 4, data: "Ym9keQ" }));
  for (const body of [
    { ...part("text/plain", "", "2"), body: { size: 4, attachmentId: "body-only" } },
    { ...part("text/html", "", "2"), body: { size: 4, attachmentId: "body-only" } },
    filePart("image/png", ""),
  ]) {
    serveAttachment(body);
    await fileError(await download(f), "not_found", /No attachment "2" exists/);
  }
  expect(google.attachmentRequests).toHaveLength(bytesBefore);
  const many = Array.from({ length: 100 }, (_, i) => ({
    ...filePart("application/pdf", "f".repeat(200)),
    partId: String(i),
  }));
  const root = {
    ...message(MESSAGE),
    payload: { ...tree("multipart/mixed", many), filename: "root-is-not-a-file.eml" },
  };
  google.messageAnswers.set(MESSAGE, () => Response.json(root));
  serveThread([root]);
  const bounded = (await answer(await read(f))) as unknown as ThreadResult;
  expect(bounded.messages[0]!.attachments_left_out).toBeGreaterThan(0);
  expect(bounded.messages[0]!.attachments[0]).toMatchObject({
    attachment: "0",
    filename: "f".repeat(200),
  });
  for (const attachment of ["0", "99"]) {
    const out = await blocks(await download(f, { attachment }));
    expect(metadata(out)).toMatchObject({ attachment, filename: "f".repeat(200) });
    expect(resourceBytes(out)).toEqual(CONTENT);
  }
  const single = { ...message(MESSAGE), payload: { ...filePart(), partId: "" } };
  google.messageAnswers.set(MESSAGE, () => Response.json(single));
  expect(resourceBytes(await blocks(await download(f, { attachment: "0" })))).toEqual(CONTENT);
});

it("downloads an attached mail as one file and refuses positions inside it", async () => {
  const f = await allowedAttachment(codeClient);
  await permission(f, f.personal, true, "read_thread");
  const bytes = new TextEncoder().encode("Subject: Attached mail\r\n\r\nInner body\r\n");
  const raw = serveAttachment({
    ...filePart("message/rfc822", "forwarded.eml"),
    body: { size: bytes.length, attachmentId: "attached-mail" },
    parts: [{ ...filePart("application/pdf", "inner.pdf"), partId: "2.0" }],
  });
  serveThread([raw]);
  google.attachmentAnswers.set("attached-mail", () =>
    Response.json({ size: bytes.length, data: Buffer.from(bytes).toString("base64url") }),
  );
  const listed = (await answer(await read(f))) as unknown as ThreadResult;
  expect(listed.messages[0]!.attachments).toEqual([
    { attachment: "2", filename: "forwarded.eml", type: "message/rfc822", size: bytes.length },
  ]);
  const out = await blocks(await download(f));
  expect(metadata(out)).toEqual({
    account: PERSONAL,
    message: MESSAGE,
    ...listed.messages[0]!.attachments[0],
  });
  expect(out.content[1]).toMatchObject({
    type: "resource",
    resource: { uri: "attachment://file/forwarded.eml", mimeType: "message/rfc822" },
  });
  expect(resourceBytes(out)).toEqual(bytes);
  await fileError(
    await download(f, { attachment: "2.0" }),
    "not_found",
    /No attachment "2.0" exists/,
  );
  expect(google.attachmentRequests).toEqual([
    `${MESSAGES_URL}/${MESSAGE}/attachments/attached-mail`,
  ]);
});

it("reads inline, freshly fetched and empty bytes with only the necessary GET requests", async () => {
  const f = await allowedAttachment();
  serveAttachment();
  expect(resourceBytes(await blocks(await download(f)))).toEqual(CONTENT);
  let version = 0;
  google.messageAnswers.set(MESSAGE, () => {
    const id = `fresh-${++version}`;
    google.attachmentAnswers.set(id, () =>
      Response.json({ size: 8, data: Buffer.from(CONTENT).toString("base64url") }),
    );
    return Response.json({
      ...message(MESSAGE),
      payload: { ...filePart(), body: { size: 9, attachmentId: id } },
    });
  });
  for (let i = 0; i < 2; i++) {
    const fetched = await blocks(await download(f));
    expect(metadata(fetched).size).toBe(9);
    expect(resourceBytes(fetched)).toEqual(CONTENT);
  }
  serveAttachment({ ...filePart(), body: { size: 0 } });
  expect(resourceBytes(await blocks(await download(f)))).toEqual(new Uint8Array());
  serveAttachment({ ...filePart(), body: { size: 8 } });
  await fileError(await download(f), "google_unavailable", unavailableMessage(PERSONAL));
  expect(google.messageRequests).toHaveLength(5);
  expect(google.attachmentRequests).toEqual([
    `${MESSAGES_URL}/${MESSAGE}/attachments/fresh-1`,
    `${MESSAGES_URL}/${MESSAGE}/attachments/fresh-2`,
  ]);
  expect(google.methods).toEqual(Array(7).fill("GET"));
});

it("returns exactly 12,000,000 bytes by digest and refuses larger stated or actual sizes", async () => {
  const f = await allowedAttachment();
  const large = Uint8Array.from({ length: 12_000_000 }, (_, i) => (i * 31 + 129) % 256);
  serveAttachment({ ...filePart(), body: { size: 12_000_000, attachmentId: "large" } });
  google.attachmentAnswers.set("large", () =>
    Response.json({ size: large.length, data: Buffer.from(large).toString("base64url") }),
  );
  const actual = resourceBytes(await blocks(await download(f)));
  expect(actual.length).toBe(12_000_000);
  expect(Buffer.from(await crypto.subtle.digest("SHA-256", actual))).toEqual(
    Buffer.from(await crypto.subtle.digest("SHA-256", large)),
  );
  serveAttachment({ ...filePart(), body: { size: 12_000_001, attachmentId: "too-large" } });
  await fileError(
    await download(f),
    "attachment_too_large",
    'The attachment "menu.pdf" has 12,000,001 bytes. The limit is 12,000,000 bytes.',
  );
  expect(google.attachmentRequests).toHaveLength(1);
  serveAttachment({ ...filePart(), body: { size: 1, attachmentId: "actual-large" } });
  google.attachmentAnswers.set("actual-large", () =>
    Response.json({ size: 1, data: Buffer.from(new Uint8Array(12_000_001)).toString("base64url") }),
  );
  await fileError(
    await download(f),
    "attachment_too_large",
    'The attachment "menu.pdf" has 12,000,001 bytes. The limit is 12,000,000 bytes.',
  );
});

const otherReaders = [
  { label: "Claude's stated name", client: "Anthropic/ClaudeAI", older: false },
  { label: "no stated name", client: null, older: false },
  { label: "the older protocol form", client: null, older: true },
  { label: "the near name claude-code-x", client: "claude-code-x", older: false },
  { label: "the near name Claude-Code", client: "Claude-Code", older: false },
] as const;
const fromReader = (
  f: Awaited<ReturnType<typeof allowedAttachment>>,
  reader: { client: string | null; older: boolean },
) =>
  reader.older
    ? toolCall(f.mcp, "get_attachment", { account: PERSONAL, message: MESSAGE, attachment: "2" })
    : download(f, {}, reader.client);

it("recognizes an OAuth-verified Claude Code connection without relying on a stated name", async () => {
  const f = await allowedAttachment(codeClient);
  serveAttachment();
  for (const reader of otherReaders) {
    expect(resourceBytes(await blocks(await fromReader(f, reader)))).toEqual(CONTENT);
  }
  expect(google.messageRequests).toHaveLength(otherReaders.length);
});

it("refuses PDF before fetching bytes when a ChatGPT connection states claude-code", async () => {
  const f = await allowedAttachment(clients[2]);
  serveAttachment({ ...filePart(), body: { size: CONTENT.length, attachmentId: "chatgpt-pdf" } });
  google.attachmentAnswers.set("chatgpt-pdf", () =>
    Response.json({ size: CONTENT.length, data: Buffer.from(CONTENT).toString("base64url") }),
  );
  await fileError(
    await download(f, {}, "claude-code"),
    "attachment_not_readable",
    'This client cannot read "menu.pdf" (type "application/pdf"). The owner can open it with Claude Code.',
  );
  expect(google.messageRequests).toEqual([`${MESSAGES_URL}/${MESSAGE}?format=full`]);
  expect(google.attachmentRequests).toEqual([]);
});

it("treats a non-string client name in an older request as unnamed on a Claude connection", async () => {
  const f = await allowedAttachment();
  serveAttachment();
  await fileError(
    await f.mcp.call("tools/call", undefined, {
      name: "get_attachment",
      arguments: { account: PERSONAL, message: MESSAGE, attachment: "2" },
      _meta: { "io.modelcontextprotocol/clientInfo": { name: 27, version: "1" } },
    }),
    "attachment_not_readable",
    /This client cannot read "menu.pdf"/,
  );
});

it.each(otherReaders)(
  "refuses PDF before fetching bytes for $label on a Claude connection",
  async (reader) => {
    const f = await allowedAttachment();
    serveAttachment({ ...filePart(), body: { size: 8, attachmentId: "do-not-fetch" } });
    await fileError(
      await fromReader(f, reader),
      "attachment_not_readable",
      'This client cannot read "menu.pdf" (type "application/pdf"). The owner can open it with Claude Code.',
    );
    expect(google.messageRequests).toHaveLength(1);
    expect(google.attachmentRequests).toEqual([]);
  },
);

it("refuses an oversized unreadable type for its size before checking the caller's formats", async () => {
  const f = await allowedAttachment();
  serveAttachment({ ...filePart(), body: { size: 12_000_001, attachmentId: "do-not-fetch" } });
  await fileError(
    await download(f, {}, "Anthropic/ClaudeAI"),
    "attachment_too_large",
    'The attachment "menu.pdf" has 12,000,001 bytes. The limit is 12,000,000 bytes.',
  );
  expect(google.attachmentRequests).toEqual([]);
});

it.each(["image/svg+xml", "image/heic", "application/x-text"])(
  "refuses unsupported type %s before fetching bytes",
  async (type) => {
    const f = await allowedAttachment();
    serveAttachment({ ...filePart(type), body: { size: 8, attachmentId: "do-not-fetch" } });
    google.attachmentAnswers.set("do-not-fetch", () =>
      Response.json({ size: CONTENT.length, data: Buffer.from(CONTENT).toString("base64url") }),
    );
    await fileError(
      await download(f, {}, "Anthropic/ClaudeAI"),
      "attachment_not_readable",
      `This client cannot read "menu.pdf" (type "${type}"). The owner can open it with Claude Code.`,
    );
    expect(google.attachmentRequests).toEqual([]);
  },
);

it("renders the four image types with lower-case media types and text for named, unnamed and older requests", async () => {
  const f = await allowedAttachment();
  const cases = [
    ["image/png", otherReaders[0]],
    ["IMAGE/JPEG", otherReaders[1]],
    ["image/gif", otherReaders[2]],
    ["image/webp", otherReaders[3]],
  ] as const;
  for (const [type, reader] of cases) {
    serveAttachment(filePart(type, "image"));
    const out = await blocks(await fromReader(f, reader));
    expect(out.isError).toBeUndefined();
    expect(out.content).toHaveLength(2);
    expect(out.content[1]).toEqual({
      type: "image",
      mimeType: type.toLowerCase(),
      data: Buffer.from(CONTENT).toString("base64"),
    });
  }
  for (const reader of otherReaders.slice(0, 3)) {
    serveAttachment(filePart("TEXT/PLAIN", "notes", new TextEncoder().encode("Hola ñ 🙂\n")));
    const out = await blocks(await fromReader(f, reader));
    expect(out.isError).toBeUndefined();
    expect(out.content).toHaveLength(2);
    expect(out.content[1]).toEqual({ type: "text", text: "Hola ñ 🙂\n" });
  }
  expect(google.messageRequests).toHaveLength(7);
  expect(google.attachmentRequests).toEqual([]);
});

it("decodes UTF-8 or the declared charset, respecting control bytes, quotes and the charset bound", async () => {
  const f = await allowedAttachment();
  const cases = [
    [new Uint8Array([0x6f, 0x6c, 0xe9]), 'text/plain; charset="iso-8859-1"', "olé"],
    [new Uint8Array([0xe9]), "text/plain; charset=iso-8859-1", "é"],
    [new TextEncoder().encode("ñ 🙂"), "text/plain; charset=iso-8859-1", "ñ 🙂"],
    [new TextEncoder().encode("UTF-8"), "text/plain; charset=unknown", "UTF-8"],
    [
      new Uint8Array([0x1b, 0x24, 0x42, 0x46, 0x7c, 0x4b, 0x5c, 0x1b, 0x28, 0x42]),
      "text/plain; charset=iso-2022-jp",
      "日本",
    ],
    [new Uint8Array([0x48, 0, 0x69, 0]), "text/plain; charset=utf-16le", "Hi"],
    [new Uint8Array([0x48, 0, 0x69]), "text/plain; charset=utf-16le", null],
    [new Uint8Array([0x1b, 0x24, 0x58]), "text/plain; charset=iso-2022-jp", null],
    [new Uint8Array([0, 0x41]), "text/plain; charset=unknown", null],
    [new Uint8Array([255]), null, null],
    [new Uint8Array([255]), "text/plain; charset=unknown", null],
    [new Uint8Array([255]), 'text/plain; charset="iso-8859-1' + " ".repeat(40) + '"', null],
    [new Uint8Array([255]), "text/plain; charset=utf-8", null],
    [new Uint8Array([0xe9]), 'text/plain; name="a; charset=iso-8859-1; b.txt"', null],
    [new Uint8Array([0xe9]), 'text/plain; name="a; charset=utf-16le.txt"; CHARSET=iso-8859-1', "é"],
    [
      new Uint8Array([0xe9]),
      'text/plain; name="a\\\"; charset=utf-16le; b.txt"; charset="iso-8859-1"',
      "é",
    ],
    [new Uint8Array([0xe9]), "text/plain; name=owner's-notes.txt; charset=iso-8859-1", "é"],
  ] as const;
  for (const [bytes, contentType, expected] of cases) {
    const file = filePart("text/plain", "notes.txt", bytes);
    serveAttachment({
      ...file,
      headers: contentType === null ? [] : [{ name: "cOnTeNt-TyPe", value: contentType }],
    });
    if (expected === null)
      await fileError(
        await download(f, {}, null),
        "attachment_not_readable",
        /This client cannot read "notes.txt"/,
      );
    else
      expect((await blocks(await download(f, {}, null))).content[1]).toEqual({
        type: "text",
        text: expected,
      });
  }
  expect(google.messageRequests).toHaveLength(cases.length);
  expect(google.attachmentRequests).toEqual([]);
});

it("escapes sender-controlled error fields, handles no name and audits both refusals", async () => {
  const f = await allowedAttachment();
  serveAttachment(filePart('application/x-"bad\ntype', 'bad"\nfile'));
  await fileError(
    await download(f, {}, null),
    "attachment_not_readable",
    'This client cannot read "bad\\"\\nfile" (type "application/x-\\"bad\\ntype"). The owner can open it with Claude Code.',
  );
  serveAttachment({
    ...filePart("application/pdf", ""),
    body: { size: 12_000_001, attachmentId: "unused" },
  });
  await fileError(
    await download(f),
    "attachment_too_large",
    "The attachment (no name) has 12,000,001 bytes. The limit is 12,000,000 bytes.",
  );
  expect((await callRows()).map((r) => r.outcome)).toEqual(["refused", "refused"]);
});

it("maps missing messages and positions and missing attachment bytes to not_found", async () => {
  const f = await allowedAttachment();
  for (const status of [400, 404]) {
    google.messageAnswers.set(MESSAGE, () => new Response(null, { status }));
    await fileError(
      await download(f),
      "not_found",
      `No message "${MESSAGE}" exists in ${PERSONAL}. A message ID works only in the account that returned it.`,
    );
  }
  serveAttachment();
  await fileError(
    await download(f, { attachment: "99" }),
    "not_found",
    /No attachment "99" exists/,
  );
  serveAttachment({ ...filePart(), body: { size: 8, attachmentId: "gone" } });
  await fileError(await download(f), "not_found", /No attachment "2" exists/);
});

it("rejects invalid input without Gmail and maps other Gmail failures to google_unavailable", async () => {
  const f = await allowedAttachment();
  for (const [field, values] of [
    ["message", [undefined, 1, "", "a".repeat(65), "a/b", "..", "%2F", "a.b", "a?b", "a\n", "é"]],
    ["attachment", [undefined, 1, "", "0.", ".0", "0..1", "x", "1/2", "1".repeat(65)]],
    ["account", [undefined, 1]],
  ] as const) {
    for (const value of values)
      await fileError(
        await download(f, { [field]: value }),
        "invalid_arguments",
        {
          account: "The account field must be a string.",
          message: "The message field must be a message ID that read_thread returned.",
          attachment: "The attachment field must be an attachment ID that read_thread returned.",
        }[field],
      );
  }
  expect(googleTraffic()).toEqual([]);
  const validMessage = "a".repeat(60) + "A-9_";
  const validAttachment = "1".repeat(64);
  google.messageAnswers.set(validMessage, () =>
    Response.json({
      ...message(validMessage),
      payload: { ...filePart(), partId: validAttachment },
    }),
  );
  const valid = await blocks(
    await download(f, { message: validMessage, attachment: validAttachment }),
  );
  expect(metadata(valid)).toMatchObject({ message: validMessage, attachment: validAttachment });
  expect(resourceBytes(valid)).toEqual(CONTENT);
  for (const response of [
    new Response(null, { status: 500 }),
    Response.json({}),
    Response.json({ ...message(MESSAGE), internalDate: "invalid" }),
    new Response("invalid JSON"),
  ]) {
    google.messageAnswers.set(MESSAGE, () => response.clone());
    await fileError(await download(f), "google_unavailable", unavailableMessage(PERSONAL));
  }
  for (const response of [
    new Response(null, { status: 500 }),
    Response.json({ data: 2 }),
    Response.json({ data: "!invalid" }),
  ]) {
    serveAttachment({ ...filePart(), body: { size: 8, attachmentId: "bad" } });
    google.attachmentAnswers.set("bad", () => response.clone());
    await fileError(await download(f), "google_unavailable", unavailableMessage(PERSONAL));
  }
});

it("lists the attachment tool with its public schema at ask or allow and removes it at deny", async () => {
  const f = await allowedAttachment();
  for (const setting of ["allow", "ask", "deny"]) {
    await f.mcp.browser.post(`/connections/${f.connection.id}/permissions`, {
      account: f.personal.id,
      tool: "get_attachment",
      setting,
    });
    const tools = (await rpcResult(await f.mcp.call())).tools as Array<{
      name: string;
      inputSchema: unknown;
    }>;
    if (setting === "deny") expect(tools.map((t) => t.name)).not.toContain("get_attachment");
    else
      expect(tools.find((t) => t.name === "get_attachment")).toMatchObject({
        description:
          "Returns one attachment of a message of one Google account. `account` is the address of an account that list_accounts returns. `message` is a message ID and `attachment` an attachment ID that read_thread returned for that account; both work only in that account. The result has two parts. The first is JSON with the account, the message, the attachment, and the file's name, media type, and size in bytes. The second is the file. In Claude Code the file comes as an embedded resource of any type: Claude Code saves it to disk and gives its path. In other clients an image (PNG, JPEG, GIF, or WebP) comes as an image and a text file as text, and any other file, such as a PDF, returns attachment_not_readable: tell the owner that Claude Code can open it. An attachment larger than 12 MB returns attachment_too_large with its size. Downloading changes nothing in Gmail. When the owner sets this tool to ask, it returns a pending approval with a link instead of the file; get_approval returns the file after the owner approves, for one hour.",
        annotations: { readOnlyHint: true },
        inputSchema: {
          type: "object",
          required: ["account", "message", "attachment"],
          properties: {
            account: { type: "string" },
            message: { type: "string", minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9_-]+$" },
            attachment: { type: "string", maxLength: 64, pattern: "^\\d+(\\.\\d+)*$" },
          },
        },
      });
  }
  const html = await (await f.mcp.browser.get(`/connections/${f.connection.id}`)).text();
  const page = JSON.parse(
    /<script id="page-props" type="application\/json">([\s\S]*?)<\/script>/.exec(html)![1]!,
  ) as Extract<FramePage, { _tag: "Connection" }>;
  expect(page.tools.find((tool) => tool.name === "get_attachment")?.description).toBe(
    "Download a file attached to a message of this account.",
  );
});

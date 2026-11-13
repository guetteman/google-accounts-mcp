import "./support/account-checks";
import { Buffer } from "node:buffer";
import { env } from "cloudflare:workers";
import { expect, it, vi } from "vite-plus/test";
import { attaching, link, put, upload, uploads, attachCall, expectMail } from "./support/uploads";
import { callRows, expectError, fixture, permission, toolCall } from "./support/permissions";
import { callWorker, ORIGIN, testEnv } from "./support/worker";
import { answer } from "./support/approvals";
import { rpcResult } from "./support/oauth";
import { attachingTools } from "../src/mcp/attachments";
import { fixtureOpen } from "./support/accounts";
import { failingKv, setOwner, statementFailingDb } from "./support/db";
import { mime } from "./support/send";
import { google } from "./support/google";

it("gives fresh links with no upload ID and records only the tool calls", async () => {
  const f = await attaching("create_draft", "ask");
  const at = Date.parse("2030-11-09T12:00:00Z");
  vi.spyOn(Date, "now").mockReturnValue(at);
  const first = await link(f);
  const second = await link(f);
  expect(first).toEqual({
    url: expect.stringMatching(new RegExp(`^${ORIGIN}/uploads/[0-9a-f-]{36}/$`)),
    expires_at: "2030-11-09T12:15:00Z",
  });
  expect(first.url).not.toBe(second.url);
  expect(await uploads()).toHaveLength(2);
  expect((await callRows()).map((row) => [row.tool, row.account_id, row.outcome])).toEqual([
    ["create_upload_link", null, "success"],
    ["create_upload_link", null, "success"],
  ]);
  expect((await put(first.url + "a.pdf")).status).toBe(201);
  expect(await callRows()).toHaveLength(2);
});
it("refuses a link without an attaching permission and lists its complete public contract", async () => {
  const f = await fixture();
  await permission(f, f.personal, true, "read_thread");
  await expectError(
    await toolCall(f.mcp, "create_upload_link"),
    "tool_not_allowed",
    `The owner has not allowed create_draft, send_message, or send_reply on any account for this connection, so it cannot attach a file. The owner can change this at ${ORIGIN}/connections/${f.connection.id}.`,
  );
  expect(await uploads()).toEqual([]);
  expect((await callRows())[0]!.outcome).toBe("refused");
  expect(attachingTools()).toEqual(["create_draft", "send_message", "send_reply"]);
  const tools = (await rpcResult(await f.mcp.call())).tools as Array<{
    name: string;
    description: string;
    annotations: unknown;
    inputSchema: unknown;
  }>;
  const entry = tools.find((tool) => tool.name === "create_upload_link")!;
  expect(entry.annotations).toEqual({
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  });
  expect(entry.inputSchema).toEqual({ type: "object", properties: {} });
  expect(entry.description).toBe(
    "Gives a link that takes one local file, so that create_draft, send_message, or send_reply can attach it to mail. It needs a client that can read the owner's local files and send an HTTP request, such as Claude Code. It takes no input and returns `url` and `expires_at`. Send the file with one PUT request to `url` followed by the file's name, with the file's bytes as the body and its media type in the Content-Type header. With curl: `curl -sS -T <path> -H 'Content-Type: <media type>' '<url>'`. `url` ends with a slash, so curl adds the file's name itself. The answer to that request is JSON with `upload`, the ID of the stored file, and the name, type, and size that the server stored; check them against the file. Only that answer gives the ID. Then name the file as `{ \"upload\": \"<upload>\" }` in `attachments`. A link takes one file of at most 25 MB, once. The link, and a file that no call has used, end at `expires_at`. One upload attaches to one message; for another message, ask for another link. Never put a file's content into a tool argument. If the answer is a sign-in page and not JSON, the owner has not opened `/uploads/*` in Cloudflare Access yet; tell the owner. It returns tool_not_allowed when the owner has not allowed any tool that attaches files.",
  );
  expect(entry.description).toContain("curl -sS -T <path>");
  expect(entry.description).toContain("/uploads/*");
});
it.each([undefined, "text/plain; charset=utf-8", "bad media", "Application/PDF"])(
  "stores exact bytes and normalizes the type %s",
  async (type) => {
    const f = await attaching("create_draft");
    const bytes = Uint8Array.from({ length: 301 }, () => Math.floor(Math.random() * 256));
    const made = await link(f);
    const response = await put(made.url + "informe%20a%C3%B1o%202026%20%28v2%29.pdf", bytes, type);
    expect(response.status).toBe(201);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const out = await response.json<{ upload: string }>();
    const media =
      type === "Application/PDF"
        ? "application/pdf"
        : type?.startsWith("text/plain")
          ? "text/plain"
          : "application/octet-stream";
    expect(out).toEqual({
      upload: expect.stringMatching(/^[0-9a-f-]{36}$/),
      filename: "informe año 2026 (v2).pdf",
      type: media,
      size: 301,
      expires_at: made.expires_at,
    });
    expect(made.url).not.toContain(out.upload);
    await answer(await attachCall(f, [{ upload: out.upload }], {}, "create_draft"));
    expectMail({ files: [{ filename: "informe año 2026 (v2).pdf", type: media, bytes }] });
  },
);
it("keeps the file key and metadata sealed and expires KV after the latest approval", async () => {
  const f = await attaching();
  const stored = await upload(
    f,
    new TextEncoder().encode("PRIVATE_FILE_BYTES"),
    "PRIVATE_NAME.pdf",
  );
  const [row] = await uploads();
  expect(row!.file).not.toMatch(/PRIVATE_NAME|application\/pdf/);
  const ref = JSON.parse(await fixtureOpen(`${row!.id}:upload`, row!.file!)) as {
    key: string;
    name: string;
    filename: string;
    type: string;
    size: number;
  };
  expect(ref).toMatchObject({ filename: "PRIVATE_NAME.pdf", type: "application/pdf", size: 18 });
  expect(row!.file).not.toContain(ref.key);
  const listing = await env.FILES_KV.list();
  expect(listing.keys).toEqual([
    { name: ref.name, expiration: Date.parse(stored.expires_at) / 1000 + 3660 },
  ]);
  const bytes = new Uint8Array((await env.FILES_KV.get(ref.name, "arrayBuffer"))!);
  expect(new TextDecoder().decode(bytes)).not.toContain("PRIVATE_FILE_BYTES");
});
it.each(["missing", "used", "expired", "ended", "generation", "GET", "POST", "DELETE"])(
  "answers an unavailable link identically for %s without reading its body",
  async (reason) => {
    const f = await attaching();
    const made = await link(f);
    let url = made.url;
    if (reason === "used") await put(url + "first.txt");
    if (reason === "expired") await env.DB.prepare("UPDATE uploads SET expires_at = 1").run();
    if (reason === "ended")
      await env.DB.prepare("UPDATE connections SET state = 'revoked', revoked_at = ?")
        .bind(Date.now())
        .run();
    if (reason === "generation")
      await env.DB.prepare("UPDATE uploads SET generation = generation + 1").run();
    if (reason === "missing") url = `${ORIGIN}/uploads/${crypto.randomUUID()}/`;
    const baseline = await callWorker(
      new Request(`${ORIGIN}/uploads/${crypto.randomUUID()}/file`, { method: "PUT" }),
    );
    const method = ["GET", "POST", "DELETE"].includes(reason) ? reason : "PUT";
    const request = new Request(url + "file", {
      method,
      ...(method !== "GET" ? { body: new Uint8Array(1_000_000) } : {}),
    });
    const response = await callWorker(request);
    expect(request.bodyUsed).toBe(false);
    expect(response.status).toBe(404);
    expect([...response.headers]).toEqual([...baseline.headers]);
    expect(await response.json()).toEqual(await baseline.json());
  },
);
it.each([
  "",
  "%ZZ",
  "%2F",
  "%5C",
  "line%0Abreak",
  "line%C2%85break",
  "x".repeat(201),
  "multipart/form-data; boundary=test",
  "application/x-www-form-urlencoded",
])("refuses bad upload metadata %s while leaving the link usable", async (bad) => {
  const f = await attaching();
  const made = await link(f);
  const form = bad.includes("/") && !bad.startsWith("../");
  const url = made.url + (form ? "file" : bad);
  const response = await put(url, "FILE", form ? bad : undefined);
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    code: "invalid_upload",
    message: form
      ? `Send the file's bytes as the body of the PUT request, not as a form. With curl: curl -T <path> '${url}'.`
      : `Put the file's name after the link, as in ${made.url}report.pdf.`,
  });
  expect((await put(made.url + "correct.pdf")).status).toBe(201);
});
it("rejects the bare link without a slash and does not consume it", async () => {
  const made = await link(await attaching());
  expect((await put(made.url.slice(0, -1))).status).toBe(400);
  expect((await put(made.url + "ok")).status).toBe(201);
});
it.each([false, true])("takes one file when two PUTs run concurrently %s", async (concurrent) => {
  const made = await link(await attaching());
  const send = () => put(made.url + "file");
  const responses = concurrent ? await Promise.all([send(), send()]) : [await send(), await send()];
  expect(responses.map((r) => r.status).sort((a, b) => a - b)).toEqual([201, 404]);
  expect((await uploads()).filter((row) => row.file)).toHaveLength(1);
});
it.each(["length", "stream"])(
  "bounds an oversized body by %s without consuming the link",
  async (kind) => {
    const made = await link(await attaching());
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(25_000_000));
        controller.enqueue(new Uint8Array(1));
        controller.close();
      },
    });
    const request = new Request(made.url + "file", {
      method: "PUT",
      body: kind === "length" ? new Uint8Array(1) : stream,
      ...(kind === "length" ? { headers: { "Content-Length": "25000001" } } : {}),
    });
    const response = await callWorker(request);
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      code: "upload_too_large",
      message: "The file is larger than the limit of 25,000,000 bytes.",
    });
    if (kind === "length") expect(request.bodyUsed).toBe(false);
    expect((await put(made.url + "ok", null)).status).toBe(201);
  },
);
it("stores an empty file and a file exactly at the limit without changing their bytes", async () => {
  const f = await attaching("create_draft");
  const bytes = new Uint8Array(25_000_000).fill(173);
  const made = await upload(f, bytes);
  await answer(await attachCall(f, [{ upload: made.upload }], { body: "" }, "create_draft"));
  const file = mime(google.uploads[0]!.message).parts[1]!.data;
  expect(file.byteLength).toBe(bytes.byteLength);
  expect(
    Buffer.from(await crypto.subtle.digest("SHA-256", new Uint8Array(file))).toString("hex"),
  ).toBe(Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex"));
  const empty = await upload(f, new Uint8Array(), "empty", "application/octet-stream");
  expect(empty.size).toBe(0);
});
it.each(["kv", "db"])("returns no ID after a %s storage failure", async (where) => {
  const made = await link(await attaching());
  const workerEnv =
    where === "kv"
      ? testEnv({ FILES_KV: failingKv("all", env.FILES_KV) })
      : testEnv({ DB: statementFailingDb(/^UPDATE uploads SET file/) });
  const response = await put(made.url + "file", "FILE", undefined, workerEnv);
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({
    code: "server_unavailable",
    message: expect.any(String),
  });
  expect((await uploads())[0]!.file).toBeNull();
});
it.each(["locked", "setup"])("keeps the deploy gate for uploads when %s", async (reason) => {
  if (reason === "locked") await setOwner({ state: "resetting", generation: 2, email: null });
  const response = await put(
    `${ORIGIN}/uploads/${crypto.randomUUID()}/file`,
    "FILE",
    undefined,
    testEnv(reason === "setup" ? { TOKEN_KEY: undefined } : {}),
  );
  expect(response.status).toBe(503);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(await response.json()).toEqual({
    code: "server_unavailable",
    message: expect.any(String),
  });
});

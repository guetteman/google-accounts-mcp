import "./support/account-checks";
import { Buffer } from "node:buffer";
import { env } from "cloudflare:workers";
import { Effect } from "effect";
import { expect, it, vi } from "vite-plus/test";
import {
  attaching,
  copy,
  setTool,
  upload,
  uploads,
  attachCall,
  input,
  watchedFiles,
  filePart,
  serveAttachment,
  expectMail,
  noWrites,
  fileOf,
} from "./support/uploads";
import { answer, approve, page, digest, post, decided, row, get } from "./support/approvals";
import { callRows, expectError, NORTHWIND, PERSONAL } from "./support/permissions";
import { accountTraffic, google, deferred } from "./support/google";
import { CONTENT, MESSAGE } from "./support/attachment";
import { created, hold, mime, never } from "./support/send";
import { renderPage } from "../src/pages/render";
import { approvalView, viewDigest } from "../src/approvals/view";
import { readApproval } from "../src/approvals/store";
import { readConfig } from "../src/config";
import { readOwner } from "../src/owner/owner";
import { testEnv, textOf } from "./support/worker";
import { fixtureOpen, NOW } from "./support/accounts";
import { SOURCE, serveMessage } from "./support/draft";

const values = [
  { name: "To", text: "Sam <sam@example.com>", from: "agent" },
  { name: "Cc", text: "jo@example.com", from: "agent" },
  { name: "Bcc", text: "lee@example.com", from: "agent" },
  { name: "Subject", text: "Files for lunch", from: "agent" },
  { name: "Attachments", text: "2 files, 12 bytes in all", from: "agent" },
  { name: "Attachment 1 (copied)", text: "menu.pdf (application/pdf, 8 bytes)", from: "gmail" },
  { name: "Attachment 1 is copied from", text: NORTHWIND, from: "agent" },
  { name: "Attachment 1 message from", text: "Sam <sam@example.com>", from: "gmail" },
  { name: "Attachment 1 message subject", text: "Lunch", from: "gmail" },
  { name: "Attachment 1 message date", text: "Nov 11, 2026 at 09:41 UTC", from: "gmail" },
  {
    name: "Attachment 2 (sent to a link of this connection)",
    text: "local.pdf (application/pdf, 4 bytes)",
    from: "agent",
  },
  { name: "Duplicate", text: "2 (a deliberate copy of an earlier call)", from: "agent" },
  { name: "Body", text: input.body, from: "agent" },
];
it("shows the complete attachment plan and every account before approving exactly that mail", async () => {
  const f = await attaching("send_message", "ask");
  await setTool(f, "get_attachment", "allow", f.northwind);
  await env.DB.prepare("UPDATE accounts SET hd = 'northwind.example' WHERE id = ?")
    .bind(f.northwind.id)
    .run();
  const local = await upload(f);
  const ownToken = await fixtureOpen(`${f.personal.id}:access`, f.personal.access_token!);
  const sourceToken = await fixtureOpen(`${f.northwind.id}:access`, f.northwind.access_token!);
  const raw = serveAttachment();
  google.accountMessages.set(`Bearer ${sourceToken}:${MESSAGE}`, raw);
  const id = (
    await answer(
      await attachCall(
        f,
        [{ ...copy, account: ` ${NORTHWIND.toUpperCase()} ` }, { upload: local.upload }],
        { duplicate: 2 },
      ),
    )
  ).approval as string;
  const watched = watchedFiles();
  const shown = await page(f, id, testEnv({ FILES_KV: watched.files }));
  expect(shown.request.values).toEqual(values);
  expect(shown.request.also).toEqual([
    {
      label: "Download attachment",
      action: "download an attachment",
      joiner: "from",
      name: "Northwind",
      email: NORTHWIND,
      workspace: true,
    },
  ]);
  const html = await renderPage(shown).text();
  const text = textOf(html);
  expect(text).toContain(
    `It also wants to download an attachment from ${NORTHWIND} , a Workspace account.`,
  );
  expect(text.indexOf(NORTHWIND)).toBeLessThan(text.indexOf("Attachments, written by the agent"));
  expect(html.indexOf("A sent message cannot be taken back.")).toBeLessThan(
    html.indexOf(">Approve</button>"),
  );
  expect(google.messageRequests).toHaveLength(1);
  expect(google.attachmentRequests).toEqual([]);
  expect(watched.reads).toEqual([]);
  expect((await approve(f, id)).state.kind).toBe("succeeded");
  const mail = expectMail({
    files: [
      { filename: "menu.pdf", type: "application/pdf", bytes: CONTENT },
      { filename: "local.pdf", type: "application/pdf", bytes: new Uint8Array([0, 255, 10, 65]) },
    ],
  });
  const files = shown.request.values.filter((value) => /^Attachment \d+ \(/.test(value.name));
  expect(files).toHaveLength(mail.parts.length - 1);
  for (const [i, file] of files.entries()) {
    const part = fileOf(mail.parts[i + 1]!);
    expect(file.text).toBe(`${part.filename} (${part.type}, ${part.bytes.byteLength} bytes)`);
  }
  for (const request of accountTraffic)
    expect(request.authorization).toBe(
      `Bearer ${request.method === "GET" ? sourceToken : ownToken}`,
    );
  expect((await row(id))!.arguments).toBeNull();
  expect(await uploads()).toEqual([]);
  expect(await get(f, id)).toEqual({
    status: "success",
    result: { account: PERSONAL, message: "sent-1", thread: "thread-1" },
  });
  expect((await callRows()).find((call) => call.tool === "send_message")!.outcome).toBe("success");
});
it.each(["create_draft", "send_message", "send_reply"] as const)(
  "shows the outgoing file names and media types in %s",
  async (name) => {
    const f = await attaching(name, "ask");
    await setTool(f, "get_attachment", "allow", f.northwind);
    const long = "ñ".repeat(190) + ".eml";
    serveAttachment(filePart("message/rfc822", long));
    serveMessage();
    const id = (
      await answer(
        await attachCall(f, [copy], name === "send_reply" ? { message: SOURCE } : {}, name),
      )
    ).approval as string;
    const shown = await page(f, id);
    const value = shown.request.values.find((value) => value.name === "Attachment 1 (copied)")!;
    expect(value).toEqual({
      name: "Attachment 1 (copied)",
      text: `${"ñ".repeat(141)}.eml (application/octet-stream, 8 bytes)`,
      from: "gmail",
    });
    expect((await approve(f, id)).state.kind).toBe("succeeded");
    const file = fileOf(mime(google.uploads[0]!.message).parts[1]!);
    expect(value.text).toBe(`${file.filename} (${file.type}, ${file.bytes.length} bytes)`);
    expect(file.bytes).toEqual(CONTENT);
    if (name !== "create_draft")
      expect(shown.request.notes).toEqual([
        { text: "A sent message cannot be taken back.", warning: true },
      ]);
  },
);
it.each(["404", "position", "500", "credential"])(
  "keeps a copy failure %s on the owner's page while the agent sees pending",
  async (failure) => {
    const f = await attaching("send_message", "ask");
    await setTool(f, "get_attachment", "allow", f.northwind);
    const id = (await answer(await attachCall(f, [copy]))).approval as string;
    if (failure === "404" || failure === "500")
      google.messageAnswers.set(MESSAGE, () => new Response(null, { status: Number(failure) }));
    if (failure === "position") serveAttachment({ ...filePart(), partId: "3" });
    if (failure === "credential")
      await env.DB.prepare(
        "UPDATE accounts SET refresh_token = 'v1.wrong.x.y', access_token = 'v1.wrong.x.y' WHERE id = ?",
      )
        .bind(f.northwind.id)
        .run();
    const shown = await page(f, id);
    expect(shown.state).toMatchObject({ kind: "waiting", shown: false });
    const html = await renderPage(shown).text();
    expect(html).not.toContain(">Approve</button>");
    expect(html).toContain(">Reject</button>");
    expect(textOf(html)).toContain("The server could not show this call.");
    expect(textOf(html)).toContain(`It also wants to download an attachment from ${NORTHWIND}`);
    expect((await get(f, id)).status).toBe("pending");
    expect((await decided(await post(f, id, "reject"))).state.kind).toBe("rejected");
    noWrites();
  },
);
it("keeps the approval waiting when KV cannot read an upload until a later Approve", async () => {
  const f = await attaching("send_message", "ask");
  const local = await upload(f);
  const id = (await answer(await attachCall(f, [{ upload: local.upload }]))).approval as string;
  const shown = await digest(f, id);
  const watched = watchedFiles(1);
  const first = await post(
    f,
    id,
    "approve",
    { digest: shown },
    testEnv({ FILES_KV: watched.files }),
  );
  expect(first.status).toBe(503);
  expect((await row(id))!.state).toBe("waiting");
  expect((await row(id))!.arguments).not.toBeNull();
  noWrites();
  expect((await approve(f, id)).state.kind).toBe("succeeded");
  expectMail({
    files: [
      { filename: "local.pdf", type: "application/pdf", bytes: new Uint8Array([0, 255, 10, 65]) },
    ],
  });
});
it("rebuilds a changed copy before deciding or reading any uploaded bytes", async () => {
  const f = await attaching("send_message", "ask");
  await setTool(f, "get_attachment", "allow", f.northwind);
  const local = await upload(f);
  const id = (await answer(await attachCall(f, [copy, { upload: local.upload }])))
    .approval as string;
  const shown = await digest(f, id);
  serveAttachment(filePart("application/pdf", "changed.pdf"));
  const watched = watchedFiles();
  const next = await decided(
    await post(f, id, "approve", { digest: shown }, testEnv({ FILES_KV: watched.files })),
  );
  expect(next.state).toMatchObject({ kind: "waiting", changed: true });
  expect(watched.reads).toEqual([]);
  noWrites();
});
it("names the source account when the approved run cannot read its copy", async () => {
  const f = await attaching("send_message", "ask");
  await setTool(f, "get_attachment", "allow", f.northwind);
  const id = (await answer(await attachCall(f, [copy]))).approval as string;
  const shown = await digest(f, id);
  let count = 0;
  const raw = serveAttachment();
  google.messageAnswers.set(MESSAGE, () =>
    ++count === 1 ? Response.json(raw) : new Response(null, { status: 404 }),
  );
  expect((await decided(await post(f, id, "approve", { digest: shown }))).state.kind).toBe(
    "failed",
  );
  expect(await get(f, id)).toEqual({
    status: "failed",
    error: {
      code: "not_found",
      message: `No message "${MESSAGE}" exists in ${NORTHWIND}. A message ID works only in the account that returned it.`,
    },
  });
  noWrites();
});
it.each(["deny", "ask", "approved"])(
  "checks the source again just before sending when changed to %s",
  async (change) => {
    const f = await attaching("send_message", change === "approved" ? "ask" : "allow");
    await setTool(f, "get_attachment", "allow", f.northwind);
    const id =
      change === "approved"
        ? ((await answer(await attachCall(f, [copy]))).approval as string)
        : null;
    await setTool(f, "read_thread", "allow", f.northwind);
    const shown = id ? await digest(f, id) : null;
    const held = hold(google.uploadAnswers, created());
    const work = id ? post(f, id, "approve", { digest: shown! }) : attachCall(f, [copy]);
    await held.entered;
    await setTool(f, "get_attachment", change === "ask" ? "ask" : "deny", f.northwind);
    held.release();
    if (id) {
      expect((await decided(await work)).state.kind).toBe("failed");
      expect((await row(id))!.result).toBeNull();
    } else
      await expectError(
        await work,
        change === "ask" ? "server_unavailable" : "tool_not_allowed",
        change === "ask"
          ? "The server could not complete the call. Try again later."
          : /has not allowed get_attachment on alex@northwind.example/,
      );
    expect(google.sends).toEqual([]);
  },
);
it("retains uploaded-file recovery advice after an unknown approved send", async () => {
  const f = await attaching("send_message", "ask");
  const local = await upload(f);
  const id = (await answer(await attachCall(f, [{ upload: local.upload }]))).approval as string;
  const entered = deferred();
  google.sendAnswers.push((request) => {
    entered.resolve();
    return never(request);
  });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const work = approve(f, id);
  await entered.promise;
  await vi.advanceTimersByTimeAsync(10_000);
  const done = await work;
  const message = `The server does not know whether this mail went out from ${PERSONAL}. Ask the owner to look in Sent. If it is not there, it may still be in Drafts, and the owner can send it from Gmail. Until 2030-11-16T12:00:00Z, repeating this call does not send it again. Only if the owner says that it is in neither place, call again with duplicate: 2 and a new upload of each file.`;
  expect(done.state).toEqual({ kind: "unknown", message });
  expect(await get(f, id)).toEqual({
    status: "unknown",
    error: { code: "outcome_unknown", message },
  });
  expect((await page(f, id)).state).toEqual({ kind: "unknown", message });
});
it("keeps a late-used upload readable for the full approval hour", async () => {
  const f = await attaching("send_message", "ask");
  const local = await upload(f);
  vi.mocked(Date.now).mockReturnValue(NOW + 14 * 60_000);
  const id = (await answer(await attachCall(f, [{ upload: local.upload }]))).approval as string;
  vi.mocked(Date.now).mockReturnValue(NOW + 73 * 60_000);
  await f.mcp.browser.authenticate();
  expect((await approve(f, id)).state.kind).toBe("succeeded");
  expectMail({
    files: [
      { filename: "local.pdf", type: "application/pdf", bytes: new Uint8Array([0, 255, 10, 65]) },
    ],
  });
});
it("matches accounts by their IDs and covers additional account lines in the digest", async () => {
  const f = await attaching("send_message", "ask");
  await setTool(f, "get_attachment", "allow", f.northwind);
  const id = (await answer(await attachCall(f, [copy]))).approval as string;
  const owner = await Effect.runPromise(readOwner(env.DB));
  const approval = await Effect.runPromise(
    readApproval(
      { db: env.DB, owner: { generation: owner.generation, email: owner.email! } },
      id as never,
      Date.now(),
    ),
  );
  const config = readConfig(testEnv());
  if (!approval || config._tag === "Failure") throw new Error("Missing fixture");
  const a = await approvalView(
    { ...approval, accounts: [...approval.accounts].reverse() },
    config.success.tokenKey,
    Date.now(),
  );
  expect(a.page.request.account.email).toBe(PERSONAL);
  expect(a.page.request.also?.[0]!.email).toBe(NORTHWIND);
  const one = { ...a.page.request, also: [] };
  const { also: _also, ...old } = one;
  const canonical = JSON.stringify(old);
  // Today's field order is explicit in the fixture, independent of the digest implementation.
  const oldCanonical = JSON.stringify({
    connection: old.connection,
    account: old.account,
    tool: old.tool,
    notes: old.notes,
    values: old.values,
  });
  expect(canonical).toBe(oldCanonical);
  expect(await viewDigest(one)).toBe(
    Buffer.from(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(oldCanonical)),
    ).toString("hex"),
  );
  expect(await viewDigest(a.page.request)).not.toBe(
    await viewDigest({
      ...a.page.request,
      also: a.page.request.also!.map((use) => ({ ...use, email: "changed@example.com" })),
    }),
  );
});

it.each(["create_draft", "send_reply"] as const)(
  "compares every value in the %s attachment view in order",
  async (name) => {
    const f = await attaching(name, "ask");
    await setTool(f, "get_attachment", "allow", f.northwind);
    const local = await upload(f);
    serveMessage();
    const id = (
      await answer(
        await attachCall(
          f,
          [copy, { upload: local.upload }],
          { duplicate: 2, ...(name === "send_reply" ? { message: SOURCE } : {}) },
          name,
        ),
      )
    ).approval as string;
    const expected =
      name === "create_draft"
        ? values
        : [
            { name: "Answers a message from", text: "Sam <sam@example.com>", from: "gmail" },
            { name: "Its subject", text: "Lunch", from: "gmail" },
            { name: "Its date", text: "Nov 11, 2026 at 09:41 UTC", from: "gmail" },
            { name: "To", text: "Sam <sam@example.com>", from: "gmail" },
            { name: "Subject", text: "Re: Lunch", from: "gmail" },
            ...values.slice(4),
          ];
    expect((await page(f, id)).request.values).toEqual(expected);
  },
);
it("names both tools even when the copy comes from the sending account", async () => {
  const f = await attaching("send_message", "ask");
  await setTool(f, "get_attachment", "allow");
  const id = (await answer(await attachCall(f, [{ ...copy, account: PERSONAL }])))
    .approval as string;
  const shown = await page(f, id);
  expect(shown.request.account.email).toBe(PERSONAL);
  expect(shown.request.also).toEqual([
    {
      label: "Download attachment",
      action: "download an attachment",
      joiner: "from",
      name: "Personal",
      email: PERSONAL,
      workspace: false,
    },
  ]);
  expect(textOf(await renderPage(shown).text())).toContain(
    `It also wants to download an attachment from ${PERSONAL}`,
  );
});
it.each(["tool", "account"] as const)(
  "lists the used settings or accounts when a two-account approval ends by %s",
  async (by) => {
    const f = await attaching("send_message", "ask");
    await setTool(f, "get_attachment", "allow", f.northwind);
    const id = (await answer(await attachCall(f, [copy]))).approval as string;
    if (by === "tool") await setTool(f, "get_attachment", "deny", f.northwind);
    else await f.mcp.browser.post(`/accounts/${f.northwind.id}/remove`);
    const shown = await page(f, id);
    const text = textOf(await renderPage(shown).text());
    expect(text).toContain(
      by === "tool"
        ? "While this request waited, you set one of the tools it uses to Not allowed for"
        : "While this request waited, you removed an account that it uses:",
    );
    expect(text).toContain("Personal");
    expect(text).toContain("Northwind");
    if (by === "tool") {
      expect(text).toContain("Send message on Personal");
      expect(text).toContain("Download attachment on Northwind");
    }
  },
);

it("bounds copied message facts and labels an unnamed file without reading its bytes", async () => {
  const f = await attaching("send_message", "ask");
  await setTool(f, "get_attachment", "allow", f.northwind);
  const raw = serveAttachment({
    ...filePart("application/pdf", ""),
    body: { size: 8, attachmentId: "unnamed" },
  });
  const full = {
    ...raw,
    payload: {
      ...raw.payload,
      headers: [
        { name: "From", value: "F".repeat(501) },
        { name: "Subject", value: "S".repeat(501) },
      ],
    },
  };
  google.messageAnswers.set(MESSAGE, () => Response.json(full));
  const id = (await answer(await attachCall(f, [copy]))).approval as string;
  const shown = await page(f, id);
  expect(shown.request.values.slice(4, -1)).toEqual([
    { name: "Attachments", text: "1 file, 8 bytes in all", from: "gmail" },
    { name: "Attachment 1 (copied)", text: "(no name) (application/pdf, 8 bytes)", from: "gmail" },
    { name: "Attachment 1 is copied from", text: NORTHWIND, from: "agent" },
    { name: "Attachment 1 message from", text: "F".repeat(499) + "…", from: "gmail" },
    { name: "Attachment 1 message subject", text: "S".repeat(499) + "…", from: "gmail" },
    { name: "Attachment 1 message date", text: "Nov 11, 2026 at 09:41 UTC", from: "gmail" },
  ]);
  expect(google.attachmentRequests).toEqual([]);
});

it("names the source account with Workspace context in every decided page", async () => {
  const f = await attaching("send_message", "ask");
  await setTool(f, "get_attachment", "allow", f.northwind);
  await env.DB.prepare("UPDATE accounts SET hd = 'northwind.example' WHERE id = ?")
    .bind(f.northwind.id)
    .run();
  const id = (await answer(await attachCall(f, [copy]))).approval as string;
  const waiting = await page(f, id);
  const states: Array<(typeof waiting)["state"]> = [
    { kind: "running" },
    { kind: "succeeded" },
    { kind: "failed", message: null },
    { kind: "unknown" },
    { kind: "rejected" },
    { kind: "expired" },
    { kind: "ended", by: "connection" },
  ];
  for (const state of states) {
    const html = await renderPage({ ...waiting, state }).text();
    expect(textOf(html)).toContain(
      `It also asked to download an attachment from ${NORTHWIND} , a Workspace account.`,
    );
    expect(html).toMatch(/<bdi[^>]*>alex@northwind\.example<\/bdi>/);
  }
  expect(textOf(await renderPage({ ...waiting, unconfirmed: true }).text())).toContain(
    `It also asked to download an attachment from ${NORTHWIND} , a Workspace account.`,
  );
});
it("sanitizes a retained upload reference in the shared plan before showing its fields", async () => {
  const f = await attaching("send_message", "ask");
  const local = await upload(f);
  const stored = (await uploads())[0]!;
  const ref = JSON.parse(await fixtureOpen(`${stored.id}:upload`, stored.file!)) as Record<
    string,
    unknown
  >;
  const { fixtureSeal } = await import("./support/accounts");
  const sealed = await fixtureSeal(
    `${stored.id}:upload`,
    JSON.stringify({ ...ref, filename: "ñ".repeat(190) + ".eml", type: "message/rfc822" }),
  );
  await env.DB.prepare("UPDATE uploads SET file = ? WHERE id = ?").bind(sealed, stored.id).run();
  const id = (await answer(await attachCall(f, [{ upload: local.upload }]))).approval as string;
  const shown = await page(f, id);
  expect(shown.request.values.slice(4, -1)).toEqual([
    { name: "Attachments", text: "1 file, 4 bytes in all", from: "agent" },
    {
      name: "Attachment 1 (sent to a link of this connection)",
      text: `${"ñ".repeat(141)}.eml (application/octet-stream, 4 bytes)`,
      from: "agent",
    },
  ]);
  expect((await approve(f, id)).state.kind).toBe("succeeded");
  expectMail({
    files: [
      {
        filename: "ñ".repeat(141) + ".eml",
        type: "application/octet-stream",
        bytes: new Uint8Array([0, 255, 10, 65]),
      },
    ],
  });
});
it("closes every source request timer after building a page", async () => {
  const f = await attaching("send_message", "ask");
  await setTool(f, "get_attachment", "allow", f.northwind);
  const id = (await answer(await attachCall(f, [copy]))).approval as string;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  expect((await page(f, id)).state).toMatchObject({ kind: "waiting", shown: true });
  expect(vi.getTimerCount()).toBe(0);
});
it.each(["allow", "ask"] as const)(
  "checks the source before creating a copied draft under %s",
  async (setting) => {
    const f = await attaching("create_draft", setting);
    await setTool(f, "get_attachment", "allow", f.northwind);
    await setTool(f, "read_thread", "allow", f.northwind);
    const pending =
      setting === "ask"
        ? ((await answer(await attachCall(f, [copy], {}, "create_draft"))).approval as string)
        : null;
    const shown = pending ? await digest(f, pending) : null;
    const raw = serveAttachment({ ...filePart(), body: { size: 1, attachmentId: "held-file" } });
    if (pending) {
      // Keep the view unchanged and hold only the run's attachment bytes.
      serveAttachment();
      const original = google.messageAnswers.get(MESSAGE)!;
      let reads = 0;
      google.messageAnswers.set(MESSAGE, (request) =>
        ++reads === 1 ? original(request) : Response.json(raw),
      );
    }
    const reading = deferred();
    const release = deferred();
    google.attachmentAnswers.set("held-file", async () => {
      reading.resolve();
      await release.promise;
      return Response.json({ data: "AA" });
    });
    const work = pending
      ? post(f, pending, "approve", { digest: shown! })
      : attachCall(f, [copy], {}, "create_draft");
    await reading.promise;
    await setTool(f, "get_attachment", "deny", f.northwind);
    release.resolve();
    if (pending) expect((await decided(await work)).state.kind).toBe("failed");
    else await expectError(await work, "tool_not_allowed", /has not allowed get_attachment/);
    noWrites();
  },
);

it("keeps the sending account out of an approved run's undeclared sources", async () => {
  const f = await attaching("send_message", "ask");
  await setTool(f, "get_attachment", "allow", f.northwind);
  const id = (await answer(await attachCall(f, [copy]))).approval as string;
  const shown = await digest(f, id);
  const { TOOLS } = await import("../src/mcp/tools");
  const tool = TOOLS.find((tool) => tool.name === "send_message")!;
  if (tool.kind !== "account" || !tool.create) throw new Error("Missing send tool");
  vi.spyOn(tool, "create").mockImplementation((_send, _account, _args, _confirm, sources) =>
    Effect.gen(function* () {
      yield* sources.from(PERSONAL)(
        (token, signal) =>
          new Request(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${MESSAGE}`, {
            signal,
            headers: { Authorization: `Bearer ${token}` },
          }),
      );
      return { message: "message", thread: "thread" };
    }),
  );
  expect((await decided(await post(f, id, "approve", { digest: shown }))).state.kind).toBe(
    "failed",
  );
  expect(await get(f, id)).toMatchObject({
    status: "failed",
    error: { code: "account_not_available" },
  });
  noWrites();
});
it("keeps the sending account out of a page's undeclared sources", async () => {
  const f = await attaching("send_message", "ask");
  await setTool(f, "get_attachment", "allow", f.northwind);
  const id = (await answer(await attachCall(f, [copy]))).approval as string;
  const { TOOLS } = await import("../src/mcp/tools");
  const tool = TOOLS.find((tool) => tool.name === "send_message")!;
  if (tool.kind !== "account") throw new Error("Missing send tool");
  vi.spyOn(tool.view, "values").mockImplementation((_args, _send, sources) =>
    sources
      .from(PERSONAL)(
        (token, signal) =>
          new Request(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${MESSAGE}`, {
            signal,
            headers: { Authorization: `Bearer ${token}` },
          }),
      )
      .pipe(Effect.as([])),
  );
  expect((await page(f, id)).state).toMatchObject({ kind: "waiting", shown: false });
  expect(accountTraffic).toEqual([]);
});

it("uses singular byte units for one uploaded byte", async () => {
  const size = 1;
  const unit = "byte";
  const f = await attaching("send_message", "ask");
  const file = await upload(f, new Uint8Array(size));
  const id = (await answer(await attachCall(f, [{ upload: file.upload }]))).approval as string;
  expect((await page(f, id)).request.values.slice(4, -1)).toEqual([
    { name: "Attachments", text: `1 file, ${size} ${unit} in all`, from: "agent" },
    {
      name: "Attachment 1 (sent to a link of this connection)",
      text: `local.pdf (application/pdf, ${size} ${unit})`,
      from: "agent",
    },
  ]);
});

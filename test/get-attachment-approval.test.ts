import { env } from "cloudflare:workers";
import { Buffer } from "node:buffer";
import { Effect, Result } from "effect";
import { expect, it, vi } from "vite-plus/test";
import "./support/account-checks";
import { openResult, sealResult } from "../src/approvals/text";
import { parseApprovalId, RESULT_LIFETIME } from "../src/approvals/model";
import { cleanupApprovals } from "../src/approvals/store";
import { readConfig } from "../src/config";
import { readOwner } from "../src/owner/owner";
import { renderPage } from "../src/pages/render";
import { previews } from "../src/pages/previews";
import type { TestEnv } from "./env";
import { NOW } from "./support/accounts";
import { approve, decided, digest, get, page, post, row } from "./support/approvals";
import { failingKv, observeStatements } from "./support/db";
import { google, MESSAGES_URL } from "./support/google";
import { callRows, googleTraffic, permission, PERSONAL } from "./support/permissions";
import { ORIGIN, testEnv, textOf } from "./support/worker";
import {
  askingAttachment,
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

const config = () => {
  const parsed = readConfig(testEnv());
  if (Result.isFailure(parsed)) throw parsed.failure;
  return parsed.success;
};
const stored = async (id: string) => {
  const record = await row(id);
  expect(record?.result).not.toBeNull();
  const payload = await openResult(config().tokenKey, parseApprovalId(id)!, record!.result!);
  if (!payload || !("result" in payload) || !payload.file)
    throw new Error("Expected stored file reference");
  return payload;
};
const collect = (
  f: Awaited<ReturnType<typeof askingAttachment>>,
  client: string | null = "claude-code",
  workerEnv?: Env,
) => f.mcp.namedCall("get_approval", { approval: f.id }, client, workerEnv).then(blocks);

it("with ask returns pending before any Gmail traffic, without checking size or type", async () => {
  const before = googleTraffic().length;
  const f = await askingAttachment({
    ...filePart(),
    body: { size: 12_000_001, attachmentId: "unused" },
  });
  expect(googleTraffic().slice(before)).toEqual([]);
  expect((await callRows()).map((r) => r.outcome)).toEqual(["pending"]);
  await permission(f, f.personal, false, "get_attachment");
  const after = googleTraffic().length;
  await fileError(await download(f), "account_not_available", /No account/);
  expect((await page(f, f.id)).state.kind).toBe("ended");
  expect(googleTraffic().slice(after)).toEqual([]);
});

it("shows six bounded Gmail values in order from one message request without downloading", async () => {
  const f = await askingAttachment({
    ...filePart(),
    body: { size: 48_213, attachmentId: "unused" },
  });
  const props = await page(f, f.id);
  expect(props.state).toMatchObject({ kind: "waiting", shown: true, digest: expect.any(String) });
  expect(props.request.tool).toMatchObject({
    label: "Download attachment",
    action: "download an attachment",
    joiner: "from",
  });
  expect(props.request.values).toEqual([
    { name: "File", text: "menu.pdf", from: "gmail" },
    { name: "Type", text: "application/pdf", from: "gmail" },
    { name: "Size", text: "48,213 bytes", from: "gmail" },
    { name: "From", text: "Sam <sam@example.com>", from: "gmail" },
    { name: "Subject", text: "Lunch", from: "gmail" },
    { name: "Date", text: "Nov 11, 2026 at 09:41 UTC", from: "gmail" },
  ]);
  expect(google.messageRequests).toEqual([`${MESSAGES_URL}/${MESSAGE}?format=full`]);
  expect(google.attachmentRequests).toEqual([]);
  const text = textOf(await renderPage(props).text());
  expect(text).toContain("Claude wants to download an attachment from Personal");
  expect(text).toContain(
    "The server read the shaded text below from Gmail. The agent did not write it.",
  );
  const raw = serveAttachment({
    ...filePart("image/png", ""),
    body: { size: 0, attachmentId: "empty" },
  });
  const long = "s".repeat(700);
  google.messageAnswers.set(MESSAGE, () =>
    Response.json({
      ...raw,
      payload: {
        ...raw.payload,
        headers: [
          { name: "From", value: long },
          { name: "Subject", value: long },
        ],
      },
    }),
  );
  const bounded = await page(f, f.id);
  expect(bounded.request.values).toContainEqual({ name: "File", text: "(no name)", from: "gmail" });
  for (const name of ["From", "Subject"])
    expect(bounded.request.values.find((v) => v.name === name)?.text).toBe("s".repeat(499) + "…");
});

it.each(["404", "position", "500"])(
  "hides Approve for %s and lets Reject run without Gmail",
  async (failure) => {
    const f = await askingAttachment();
    if (failure === "position") serveAttachment({ ...filePart(), partId: "99" });
    else google.messageAnswers.set(MESSAGE, () => new Response(null, { status: Number(failure) }));
    const props = await page(f, f.id);
    expect(props.state).toMatchObject({ kind: "waiting", shown: false, digest: null });
    const html = await renderPage(props).text();
    expect(html).not.toContain(">Approve</button>");
    expect(html).toContain(">Reject</button>");
    const before = googleTraffic().length;
    expect((await decided(await post(f, f.id, "reject"))).state.kind).toBe("rejected");
    expect(googleTraffic().slice(before)).toEqual([]);
  },
);

it("stores one encrypted value after approval, with a sealed reference and the decision expiry", async () => {
  const file = { ...filePart(), body: { size: 8, attachmentId: "download-after-approval" } };
  const f = await askingAttachment(file);
  google.attachmentAnswers.set("download-after-approval", () =>
    Response.json({ size: 8, data: Buffer.from(CONTENT).toString("base64url") }),
  );
  await page(f, f.id);
  expect((await env.FILES_KV.list()).keys).toEqual([]);
  expect(google.attachmentRequests).toEqual([]);
  expect((await approve(f, f.id)).state.kind).toBe("succeeded");
  const payload = await stored(f.id);
  expect(payload.result).toEqual({
    account: PERSONAL,
    message: MESSAGE,
    attachment: "2",
    filename: "menu.pdf",
    type: "application/pdf",
    size: 8,
  });
  expect(payload.file).toMatchObject({
    v: 1,
    filename: "menu.pdf",
    type: "application/pdf",
    charset: null,
    size: 8,
  });
  const record = (await row(f.id))!;
  expect(record.result).not.toContain(payload.file!.key);
  expect(record.result).not.toContain(payload.file!.name);
  expect((await env.FILES_KV.list()).keys).toEqual([
    { name: payload.file!.name, expiration: Math.floor(record.decided_at! / 1000) + 3660 },
  ]);
  const ciphertext = Buffer.from((await env.FILES_KV.get(payload.file!.name, "arrayBuffer"))!);
  expect(ciphertext.includes(Buffer.from(CONTENT))).toBe(false);
  const out = await collect(f);
  expect(metadata(out)).toEqual({ status: "success", result: payload.result });
  expect(out.content[1]).toMatchObject({
    type: "resource",
    resource: { uri: `attachment://${MESSAGE}/2`, mimeType: "application/pdf" },
  });
  expect(resourceBytes(out)).toEqual(CONTENT);
  expect((await callRows())[0]!.outcome).toBe("success");
});

it.each(["image/png", "text/plain"])(
  "collects approved %s in the collecting client's form",
  async (type) => {
    const bytes = new TextEncoder().encode("Hola ñ 🙂");
    const f = await askingAttachment(filePart(type, "file", bytes));
    expect((await approve(f, f.id)).state.kind).toBe("succeeded");
    const out = await collect(f, "Anthropic/ClaudeAI");
    expect(out.isError).toBeUndefined();
    expect(metadata(out)).toMatchObject({
      status: "success",
      result: { type, size: bytes.length },
    });
    expect(out.content).toHaveLength(2);
    expect(out.content[1]).toEqual(
      type.startsWith("text/")
        ? { type: "text", text: "Hola ñ 🙂" }
        : { type: "image", mimeType: type, data: Buffer.from(bytes).toString("base64") },
    );
  },
);

it.each(["application/pdf", "text/plain"])(
  "keeps unreadable %s available for a later Claude Code collector",
  async (type) => {
    const f = await askingAttachment(filePart(type, "file", CONTENT));
    await approve(f, f.id);
    const before = await stored(f.id);
    const unreadable = await collect(f, null);
    expect(unreadable.isError).toBeUndefined();
    expect(unreadable.content).toHaveLength(1);
    expect(metadata(unreadable)).toEqual({
      status: "success",
      result: before.result,
      error: {
        code: "attachment_not_readable",
        message: `This client cannot read "file" (type "${type}"). The owner can open it with Claude Code.`,
      },
    });
    expect(await stored(f.id)).toEqual(before);
    expect(resourceBytes(await collect(f))).toEqual(CONTENT);
  },
);

it.each(["large", "gone"])(
  "finishes an approved %s attachment with an error and no KV value",
  async (failure) => {
    const f = await askingAttachment(
      failure === "large"
        ? { ...filePart(), body: { size: 12_000_001, attachmentId: "unused" } }
        : filePart(),
    );
    const d = await digest(f, f.id);
    if (failure === "gone") {
      const raw = serveAttachment();
      let reads = 0;
      google.messageAnswers.set(MESSAGE, () =>
        ++reads === 1 ? Response.json(raw) : new Response(null, { status: 404 }),
      );
    }
    expect((await decided(await post(f, f.id, "approve", { digest: d }))).state.kind).toBe(
      "failed",
    );
    expect(await get(f, f.id)).toMatchObject({
      status: "failed",
      error: { code: failure === "large" ? "attachment_too_large" : "not_found" },
    });
    expect((await env.FILES_KV.list()).keys).toEqual([]);
    expect((await callRows())[0]!.outcome).toBe("refused");
  },
);

it.each(["tool", "connection", "account"])(
  "purges the file reference when access ends by %s",
  async (by) => {
    const f = await askingAttachment();
    await approve(f, f.id);
    const payload = await stored(f.id);
    if (by === "tool") await permission(f, f.personal, false, "get_attachment");
    else
      expect(
        await (
          await f.mcp.browser.post(
            by === "connection"
              ? `/connections/${f.connection.id}/revoke`
              : `/accounts/${f.personal.id}/remove`,
          )
        ).json(),
      ).toEqual({ outcome: "ok" });
    expect((await row(f.id))!.result).toBeNull();
    const response = await f.mcp.namedCall("get_approval", { approval: f.id }, "claude-code");
    if (by === "connection") expect(response.status).toBe(401);
    else {
      const out = await blocks(response);
      expect(out.content).toHaveLength(1);
      expect(out.content[0]).toMatchObject({ type: "text" });
      expect((out.content[0] as { text: string }).text).not.toContain("menu.pdf");
    }
    // Purging references never deletes KV values; nobody can collect them through this approval.
    expect((await env.FILES_KV.list()).keys.map((k) => k.name)).toEqual([payload.file!.name]);
  },
);

it.each(["miss", "damaged", "unavailable"])(
  "returns running for a KV %s then returns the file without losing the reference",
  async (failure) => {
    const f = await askingAttachment();
    await approve(f, f.id);
    const before = await stored(f.id);
    let missing = true;
    const kv = new Proxy(env.FILES_KV, {
      get(target, key) {
        if (key === "get")
          return (...args: unknown[]) => {
            if (!missing)
              return Reflect.apply(
                Reflect.get(target, "get") as (...args: unknown[]) => unknown,
                target,
                args,
              );
            missing = false;
            if (failure === "unavailable") throw new Error("KV unavailable");
            return Promise.resolve(failure === "miss" ? null : new Uint8Array([1, 2, 3]).buffer);
          };
        const value: unknown = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const notReady = await collect(f, "claude-code", testEnv({ FILES_KV: kv }));
    expect(notReady.isError).toBeUndefined();
    expect(notReady.content).toHaveLength(1);
    expect(metadata(notReady)).toEqual({
      status: "running",
      message:
        "The owner approved the call and the file is not ready yet. Call get_approval again in one minute.",
    });
    expect(await stored(f.id)).toEqual(before);
    expect(resourceBytes(await collect(f, "claude-code", testEnv({ FILES_KV: kv })))).toEqual(
      CONTENT,
    );
  },
);

it("stores no file reference when permission is denied immediately after the decision", async () => {
  const f = await askingAttachment();
  const d = await digest(f, f.id);
  let decidedAlready = false;
  let denied = false;
  const observed = observeStatements(
    env.DB,
    () => {},
    (sql) => {
      if (sql.startsWith("UPDATE approvals SET state = 'approved'")) decidedAlready = true;
    },
  );
  const raw = serveAttachment();
  google.messageAnswers.set(MESSAGE, async () => {
    if (decidedAlready && !denied) {
      denied = true;
      await permission(f, f.personal, false, "get_attachment");
    }
    return Response.json(raw);
  });
  expect(
    (await decided(await post(f, f.id, "approve", { digest: d }, testEnv({ DB: observed })))).state
      .kind,
  ).toBe("succeeded");
  expect(denied).toBe(true);
  expect((await row(f.id))!.result).toBeNull();
  const out = await collect(f);
  expect(out.content).toHaveLength(1);
  expect(metadata(out)).toEqual({ status: "success" });
  expect((await env.FILES_KV.list()).keys).toHaveLength(1);
});

it("withholds the result after one hour and lets cleanup purge the sealed file reference", async () => {
  const f = await askingAttachment();
  await approve(f, f.id);
  await stored(f.id);
  vi.spyOn(Date, "now").mockReturnValue(NOW + RESULT_LIFETIME + 1);
  const out = await collect(f);
  expect(out.content).toHaveLength(1);
  expect(metadata(out)).toEqual({ status: "success" });
  const owner = await Effect.runPromise(readOwner(env.DB));
  await Effect.runPromise(
    cleanupApprovals(
      { db: env.DB, owner: { generation: owner.generation, email: owner.email! } },
      Date.now(),
    ),
  );
  expect((await row(f.id))!.result).toBeNull();
});

it("ends an approved KV write failure as unknown without a result or file reference", async () => {
  const f = await askingAttachment();
  expect(
    (await approve(f, f.id, testEnv({ FILES_KV: failingKv("all", env.FILES_KV) }))).state.kind,
  ).toBe("unknown");
  expect(await row(f.id)).toMatchObject({ state: "approved", outcome: "unknown", result: null });
  expect((await callRows())[0]!.outcome).toBeNull();
  const out = await collect(f);
  expect(out.content).toHaveLength(1);
  expect(metadata(out)).toEqual({ status: "unknown" });
  expect((await env.FILES_KV.list()).keys).toEqual([]);
});

it("opens file references only when their persisted schema is valid and keeps ordinary results", async () => {
  const f = await askingAttachment();
  await approve(f, f.id);
  const payload = await stored(f.id);
  const key = config().tokenKey;
  const id = parseApprovalId(f.id)!;
  expect(await openResult(key, id, await sealResult(key, id, { result: { labels: [] } }))).toEqual({
    result: { labels: [] },
  });
  for (const file of [
    { ...payload.file, key: "short" },
    { ...payload.file, v: 2 },
    { ...payload.file, size: -1 },
    { ...payload.file, charset: 2 },
    { ...payload.file, name: "token:unrelated" },
  ]) {
    // Model corrupted persisted data at the sealing boundary; production only builds FileRef.
    const invalid = { ...payload, file } as unknown as Parameters<typeof sealResult>[2];
    expect(await openResult(key, id, await sealResult(key, id, invalid))).toEqual({
      result: payload.result,
    });
  }
});

it("renders the attachment preview at 390 and 1280 pixels without overflow", async () => {
  for (const width of [390, 1280]) {
    const response = renderPage(previews["approval-waiting-attachment"]!);
    const result = await (
      await (env as TestEnv).TEST_BROWSER.fetch("http://browser/hydrate", {
        method: "POST",
        body: JSON.stringify({
          url: `${ORIGIN}/__pages/approval-waiting-attachment`,
          html: await response.text(),
          headers: Object.fromEntries(response.headers),
          layout: true,
          width,
        }),
      })
    ).json<{ overflow: boolean; errors: string[] }>();
    expect(result.errors).toEqual([]);
    expect(result.overflow).toBe(false);
  }
}, 60_000);

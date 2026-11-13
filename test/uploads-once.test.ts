import "./support/account-checks";
import { env } from "cloudflare:workers";
import { expect, it, vi } from "vite-plus/test";
import {
  attaching,
  link,
  upload,
  uploads,
  attachCall,
  setTool,
  watchedFiles,
  noWrites,
  input,
  expectMail,
} from "./support/uploads";
import { answer, approve, page, post, row, rows, get } from "./support/approvals";
import { expectError, callRows } from "./support/permissions";
import { fixtureOpen } from "./support/accounts";
import { onceRows } from "./support/draft";
import { google, deferred } from "./support/google";
import { created, hold, never } from "./support/send";
import { testEnv } from "./support/worker";
import { observeStatements } from "./support/db";
import worker from "../src/index";

const missingText = (id: string) =>
  `No upload "${id}" is available to this connection. An upload works once, in the connection that asked for its link, before it expires. Call create_upload_link and send the file again.`;
it.each(["missing", "empty-link", "expired", "other", "used"])(
  "refuses an upload that is %s identically and records a refusal",
  async (reason) => {
    const f = await attaching("create_draft");
    const file = await upload(f);
    let id = file.upload;
    if (reason === "missing") id = crypto.randomUUID();
    if (reason === "empty-link") {
      const made = await link(f);
      id = (await uploads()).find((row) => made.url.includes(row.link))!.id;
    }
    if (reason === "expired") await env.DB.prepare("UPDATE uploads SET expires_at = 1").run();
    if (reason === "other")
      await env.DB.prepare("UPDATE uploads SET connection_id = ?").bind(crypto.randomUUID()).run();
    if (reason === "used") await answer(await attachCall(f, [{ upload: id }], {}, "create_draft"));
    await expectError(
      await attachCall(f, [{ upload: id }], { body: "Another call" }, "create_draft"),
      "upload_not_available",
      missingText(id),
    );
    expect((await callRows()).at(-1)!.outcome).toBe("refused");
  },
);
it("answers the finished call before its missing upload and refuses another use or a deliberate duplicate", async () => {
  const f = await attaching("create_draft");
  const file = await upload(f);
  const first = await answer(await attachCall(f, [{ upload: file.upload }], {}, "create_draft"));
  expect(await uploads()).toEqual([]);
  const again = await answer(await attachCall(f, [{ upload: file.upload }], {}, "create_draft"));
  expect(again).toMatchObject({ ...first, repeat_of: expect.any(String) });
  expect(again.note).toMatch(/duplicate: 2 and a new upload of each file\.$/);
  await expectError(
    await attachCall(f, [{ upload: file.upload }], { duplicate: 2 }, "create_draft"),
    "upload_not_available",
    missingText(file.upload),
  );
  await setTool(f, "send_message", "allow");
  await expectError(
    await attachCall(f, [{ upload: file.upload }]),
    "upload_not_available",
    missingText(file.upload),
  );
  expect(google.uploads).toHaveLength(1);
});
it.each(["500", "400"])(
  "keeps an upload after a refused staging request %s for the same or corrected call",
  async (status) => {
    const f = await attaching();
    const file = await upload(f);
    google.uploadAnswers.push(() => new Response(null, { status: Number(status) }));
    await expectError(
      await attachCall(f, [{ upload: file.upload }]),
      status === "400" ? "message_not_sendable" : "google_unavailable",
      status === "400" ? /Gmail refused/ : /Nothing was sent/,
    );
    expect(await onceRows()).toEqual([]);
    expect(await uploads()).toHaveLength(1);
    await answer(
      await attachCall(
        f,
        [{ upload: file.upload }],
        status === "400" ? { to: ["correct@example.com"] } : {},
      ),
    );
    expect(google.sends).toHaveLength(1);
    expect(await uploads()).toEqual([]);
  },
);
it("deletes an upload after an unknown send and retains recovery advice for repeats", async () => {
  const f = await attaching();
  const file = await upload(f);
  const entered = deferred();
  google.sendAnswers.push((request) => {
    entered.resolve();
    return never(request);
  });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const work = attachCall(f, [{ upload: file.upload }]);
  await entered.promise;
  await vi.advanceTimersByTimeAsync(10_000);
  await expectError(
    await work,
    "outcome_unknown",
    /call again with duplicate: 2 and a new upload of each file\.$/,
  );
  expect(await uploads()).toEqual([]);
  await expectError(
    await attachCall(f, [{ upload: file.upload }]),
    "outcome_unknown",
    /new upload of each file/,
  );
  await expectError(
    await attachCall(f, [{ upload: file.upload }], { duplicate: 2 }),
    "upload_not_available",
    missingText(file.upload),
  );
  expect(google.sends).toHaveLength(1);
});
it.each(["ask", "allow"] as const)(
  "isolates uploads between connections under %s",
  async (setting) => {
    const first = await attaching();
    const file = await upload(first);
    const { McpClient, codeClient } = await import("./support/oauth");
    const mcp = await new McpClient(codeClient).connect("Other");
    const connections = await (await import("./support/connections")).rows();
    const connection = connections.find((row) => row.id !== first.connection.id)!;
    const other = { ...first, mcp, connection };
    await setTool(other, "send_message", setting);
    await expectError(
      await attachCall(other, [{ upload: file.upload }]),
      "upload_not_available",
      missingText(file.upload),
    );
    expect(await rows()).toEqual([]);
    await answer(await attachCall(first, [{ upload: file.upload }]));
    expect(google.sends).toHaveLength(1);
  },
);
it("moves uploads atomically into only one waiting approval", async () => {
  const f = await attaching("send_message", "ask");
  const file = await upload(f);
  const responses = await Promise.all([
    attachCall(f, [{ upload: file.upload }]),
    attachCall(f, [{ upload: file.upload }], { body: "Other call" }),
  ]);
  const results = await Promise.all(
    responses.map(async (response) => {
      const parsed = await (await import("./support/oauth")).rpcResult(response);
      return {
        error: parsed.isError,
        value: JSON.parse((parsed.content as Array<{ text: string }>)[0]!.text) as {
          approval?: string;
          code?: string;
        },
      };
    }),
  );
  expect(results.filter((result) => result.error)).toHaveLength(1);
  expect(results.find((result) => result.error)!.value.code).toBe("upload_not_available");
  const id = results.find((result) => !result.error)!.value.approval!;
  expect(await rows()).toHaveLength(1);
  expect(await uploads()).toEqual([]);
  const stored = JSON.parse(await fixtureOpen(`${id}:arguments`, (await row(id))!.arguments!)) as {
    files: Record<string, { filename: string; size: number }>;
  };
  expect(stored.files[file.upload]).toMatchObject({ filename: "local.pdf", size: 4 });
  noWrites();
});
it.each(["reject", "end", "expire"])(
  "erases every file reference when an approval is %s",
  async (ending) => {
    const f = await attaching("send_message", "ask");
    const file = await upload(f);
    const id = (await answer(await attachCall(f, [{ upload: file.upload }]))).approval as string;
    if (ending === "reject") await post(f, id, "reject");
    if (ending === "end") await setTool(f, "send_message", "deny");
    if (ending === "expire") {
      await env.DB.prepare("UPDATE approvals SET expires_at = ? WHERE id = ?")
        .bind(Date.now(), id)
        .run();
      await page(f, id);
    }
    expect((await row(id))!.arguments).toBeNull();
    expect(await uploads()).toEqual([]);
    await setTool(f, "send_message", "allow");
    await expectError(
      await attachCall(f, [{ upload: file.upload }], { body: "New" }),
      "upload_not_available",
      missingText(file.upload),
    );
  },
);
it("refuses expired uploads under ask and cleans their rows on the scheduled job", async () => {
  const f = await attaching("send_message", "ask");
  const file = await upload(f);
  vi.mocked(Date.now).mockReturnValue(Date.parse(file.expires_at));
  await expectError(
    await attachCall(f, [{ upload: file.upload }]),
    "upload_not_available",
    missingText(file.upload),
  );
  expect(await rows()).toEqual([]);
  await worker.scheduled({} as ScheduledController, testEnv());
  expect(await uploads()).toEqual([]);
});
it.each(["missing", "damaged"])(
  "keeps a %s KV file available for a safe retry",
  async (problem) => {
    const f = await attaching();
    const file = await upload(f);
    const stored = (await uploads())[0]!;
    const ref = JSON.parse(await fixtureOpen(`${stored.id}:upload`, stored.file!)) as {
      name: string;
    };
    const bytes = new Uint8Array((await env.FILES_KV.get(ref.name, "arrayBuffer"))!);
    const watched = watchedFiles(problem === "missing" ? 1 : 0);
    if (problem === "damaged") {
      const corrupt = bytes.slice();
      corrupt[15] = corrupt[15]! ^ 1;
      await env.FILES_KV.put(ref.name, corrupt);
    }
    await expectError(
      await attachCall(
        f,
        [{ upload: file.upload }],
        {},
        "send_message",
        testEnv({ FILES_KV: watched.files }),
      ),
      "upload_not_ready",
      "The server cannot read the uploaded file yet. Call again with the same arguments in one minute.",
    );
    noWrites();
    expect((await callRows()).at(-1)!.outcome).toBe("failed");
    expect(await uploads()).toHaveLength(1);
    expect(await onceRows()).toEqual([]);
    if (problem === "damaged") await env.FILES_KV.put(ref.name, bytes);
    await answer(await attachCall(f, [{ upload: file.upload }]));
    expect(google.sends).toHaveLength(1);
  },
);
it("refuses known upload sizes before KV and leaves the files usable", async () => {
  const f = await attaching();
  const first = await upload(f, new Uint8Array(13_000_000));
  const second = await upload(f, new Uint8Array(13_000_000));
  const watched = watchedFiles();
  await expectError(
    await attachCall(
      f,
      [{ upload: first.upload }, { upload: second.upload }],
      {},
      "send_message",
      testEnv({ FILES_KV: watched.files }),
    ),
    "message_too_large",
    `This message would have ${(26_000_000 + new TextEncoder().encode(input.body).byteLength).toLocaleString("en-US")} bytes of attachments and text. The limit is 25,000,000 bytes.`,
  );
  expect(watched.reads).toEqual([]);
  noWrites();
  await answer(await attachCall(f, [{ upload: first.upload }]));
  expect(google.sends).toHaveLength(1);
});
it("returns the same waiting approval after allow and sends its file only when approved", async () => {
  const f = await attaching("send_message", "ask");
  const file = await upload(f);
  const first = await answer(await attachCall(f, [{ upload: file.upload }]));
  await setTool(f, "send_message", "allow");
  expect(await answer(await attachCall(f, [{ upload: file.upload }]))).toEqual(first);
  noWrites();
  expect(await rows()).toHaveLength(1);
  expect((await approve(f, first.approval as string)).state.kind).toBe("succeeded");
  expectMail({
    files: [
      { filename: "local.pdf", type: "application/pdf", bytes: new Uint8Array([0, 255, 10, 65]) },
    ],
  });
  expect((await get(f, first.approval as string)).status).toBe("success");
});
it("leaves the file in an approval that wins before the direct call takes its row", async () => {
  const f = await attaching();
  const file = await upload(f);
  let pending: Record<string, unknown> | undefined;
  let ran = false;
  const db = observeStatements(env.DB, async (sql) => {
    if (ran || !sql.startsWith("INSERT INTO once")) return;
    ran = true;
    await setTool(f, "send_message", "ask");
    pending = await answer(await attachCall(f, [{ upload: file.upload }]));
  });
  await expectError(
    await attachCall(f, [{ upload: file.upload }], {}, "send_message", testEnv({ DB: db })),
    "upload_not_available",
    missingText(file.upload),
  );
  noWrites();
  expect(await onceRows()).toEqual([]);
  expect((await approve(f, pending!.approval as string)).state.kind).toBe("succeeded");
  expect(google.sends).toHaveLength(1);
});
it("returns running without an approval after the direct call took its row", async () => {
  const f = await attaching();
  const file = await upload(f);
  const held = hold(google.uploadAnswers, created());
  const direct = attachCall(f, [{ upload: file.upload }]);
  await held.entered;
  await setTool(f, "send_message", "ask");
  expect((await answer(await attachCall(f, [{ upload: file.upload }]))).status).toBe("running");
  expect(await rows()).toEqual([]);
  await setTool(f, "send_message", "allow");
  held.release();
  await answer(await direct);
  expect(google.sends).toHaveLength(1);
});

it("refuses upload sizes before creating an approval or reading KV", async () => {
  const f = await attaching("send_message", "ask");
  const first = await upload(f, new Uint8Array(13_000_000));
  const second = await upload(f, new Uint8Array(13_000_000));
  const watched = watchedFiles();
  await expectError(
    await attachCall(
      f,
      [{ upload: first.upload }, { upload: second.upload }],
      {},
      "send_message",
      testEnv({ FILES_KV: watched.files }),
    ),
    "message_too_large",
    /This message would have 26,000,027 bytes of attachments and text/,
  );
  expect(watched.reads).toEqual([]);
  expect(await rows()).toEqual([]);
  expect(await uploads()).toHaveLength(2);
});

it("releases the call without using its file after an upload reference read fails", async () => {
  const f = await attaching();
  const local = await upload(f);
  const { statementFailingDb } = await import("./support/db");
  const db = statementFailingDb(/^SELECT id,file FROM uploads/);
  await expectError(
    await attachCall(f, [{ upload: local.upload }], {}, "send_message", testEnv({ DB: db })),
    "server_unavailable",
    "The server could not complete the call. Try again later.",
  );
  expect(await onceRows()).toEqual([]);
  expect(await uploads()).toHaveLength(1);
  noWrites();
  await answer(await attachCall(f, [{ upload: local.upload }]));
  expect(google.sends).toHaveLength(1);
});

it("does not move an upload that expires while the approval arguments are being sealed", async () => {
  const f = await attaching("send_message", "ask");
  const local = await upload(f);
  const text = await import("../src/approvals/text");
  const original = text.sealArguments;
  vi.spyOn(text, "sealArguments").mockImplementation(async (...args) => {
    const sealed = await original(...args);
    vi.mocked(Date.now).mockReturnValue(Date.parse(local.expires_at));
    return sealed;
  });
  await expectError(
    await attachCall(f, [{ upload: local.upload }]),
    "upload_not_available",
    missingText(local.upload),
  );
  expect(await rows()).toEqual([]);
  noWrites();
});

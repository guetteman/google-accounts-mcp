import "./support/account-checks";
import { env } from "cloudflare:workers";
import { expect, it } from "vite-plus/test";
import {
  attaching,
  copy,
  setTool,
  attachCall,
  upload,
  watchedFiles,
  noWrites,
} from "./support/uploads";
import {
  expectError,
  PERSONAL,
  NORTHWIND,
  toolCall,
  callRows,
  problemCases,
} from "./support/permissions";
import { answer, page, rows, row, get } from "./support/approvals";
import { onceRows } from "./support/draft";
import { ORIGIN, testEnv } from "./support/worker";
import { google } from "./support/google";
import { seedAccount } from "./support/accounts";
import { rpcResult } from "./support/oauth";
import { CONTENT } from "./support/attachment";

it.each(["hidden", "never@example.com", "not an address", "removed"])(
  "does not disclose a source account that is %s",
  async (kind) => {
    const f = await attaching();
    if (kind === "removed")
      await env.DB.prepare(
        "UPDATE accounts SET state = 'removed', removed_at = ?, refresh_token = NULL, access_token = NULL WHERE id = ?",
      )
        .bind(Date.now(), f.northwind.id)
        .run();
    const address = ["hidden", "removed"].includes(kind) ? NORTHWIND : kind;
    const direct = await rpcResult(
      await toolCall(f.mcp, "get_attachment", {
        account: address,
        message: copy.message,
        attachment: copy.attachment,
      }),
    );
    const copied = await rpcResult(await attachCall(f, [{ ...copy, account: address }]));
    expect(copied).toEqual(direct);
    expect(JSON.parse((copied.content as Array<{ text: string }>)[0]!.text)).toEqual({
      code: "account_not_available",
      message: `No account "${address}" is available to this connection. Call list_accounts to see the accounts you can use.`,
    });
    expect(await onceRows()).toEqual([]);
    expect(await rows()).toEqual([]);
    noWrites();
    expect(google.messageRequests).toEqual([]);
  },
);
it.each([false, true])(
  "requires the source download permission also on the sending account %s",
  async (same) => {
    const f = await attaching();
    const source = same ? f.personal : f.northwind;
    await setTool(f, "read_thread", "allow", source);
    const file = await upload(f);
    await expectError(
      await attachCall(f, [{ ...copy, account: source.email }, { upload: file.upload }]),
      "tool_not_allowed",
      `The owner has not allowed get_attachment on ${source.email} for this connection. The owner can change this at ${ORIGIN}/connections/${f.connection.id}.`,
    );
    expect(await onceRows()).toEqual([]);
    expect(await rows()).toEqual([]);
    await setTool(f, "get_attachment", "allow", source);
    await answer(
      await attachCall(f, [{ ...copy, account: source.email }, { upload: file.upload }]),
    );
    expect(google.sends).toHaveLength(1);
  },
);
it.each([
  ["allow", "ask"],
  ["ask", "allow"],
  ["ask", "ask"],
] as const)(
  "asks once without reading Gmail or KV for sending %s and source %s",
  async (sending, source) => {
    const f = await attaching("send_message", sending);
    await setTool(f, "get_attachment", source, f.northwind);
    const uploaded = await upload(f, CONTENT);
    const watched = watchedFiles();
    const out = await answer(
      await attachCall(
        f,
        [copy, { upload: uploaded.upload }],
        {},
        "send_message",
        testEnv({ FILES_KV: watched.files }),
      ),
    );
    expect(out.status).toBe("pending");
    expect(await rows()).toHaveLength(1);
    expect((await row(out.approval as string))!.uses).toBe(
      JSON.stringify([
        { account: f.personal.id, tool: "send_message" },
        { account: f.northwind.id, tool: "get_attachment" },
      ]),
    );
    expect(google.messageRequests).toEqual([]);
    expect(watched.reads).toEqual([]);
    expect((await callRows()).at(-1)!.outcome).toBe("pending");
  },
);
it.each(["deny", "remove"])(
  "keeps each used pair once and ends the approval on source %s",
  async (change) => {
    const f = await attaching("send_message", "ask");
    await setTool(f, "get_attachment", "allow", f.northwind);
    const extra = await seedAccount({ email: "third@example.com", name: "Third" });
    await setTool(f, "get_attachment", "allow", extra);
    const out = await answer(await attachCall(f, [copy, copy, { ...copy, account: extra.email }]));
    const id = out.approval as string;
    expect(JSON.parse((await row(id))!.uses)).toEqual([
      { account: f.personal.id, tool: "send_message" },
      { account: f.northwind.id, tool: "get_attachment" },
      { account: extra.id, tool: "get_attachment" },
    ]);
    if (change === "deny") await setTool(f, "get_attachment", "deny", f.northwind);
    else expect((await f.mcp.browser.post(`/accounts/${f.northwind.id}/remove`)).status).toBe(200);
    expect((await page(f, id)).state).toEqual({
      kind: "ended",
      by: change === "deny" ? "tool" : "account",
    });
    expect((await row(id))!.arguments).toBeNull();
    expect((await get(f, id)).status).toBe("refused");
  },
);
it.each(problemCases.filter((entry) => entry.status !== "blocked_by_admin"))(
  "refuses a source needing $status before storing an approval",
  async (problem) => {
    const f = await attaching("send_message", "ask");
    await setTool(f, "get_attachment", "ask", f.northwind);
    const fields = Object.keys(problem.row);
    await env.DB.prepare(
      `UPDATE accounts SET ${fields.map((field) => `${field} = ?`).join(",")} WHERE id = ?`,
    )
      .bind(...Object.values(problem.row), f.northwind.id)
      .run();
    await expectError(
      await attachCall(f, [copy]),
      `account_${problem.status}`,
      problem.message.replaceAll(PERSONAL, NORTHWIND),
    );
    expect(await onceRows()).toEqual([]);
    expect(await rows()).toEqual([]);
    expect(google.messageRequests).toEqual([]);
  },
);
it("checks the sending account before any source", async () => {
  const f = await attaching();
  await setTool(f, "send_message", "deny");
  await expectError(
    await attachCall(f, [{ ...copy, account: "invalid" }]),
    "account_not_available",
    `No account "${PERSONAL}" is available to this connection. Call list_accounts to see the accounts you can use.`,
  );
  expect(await rows()).toEqual([]);
});
it("records source account IDs once even for hidden sources, and no agent addresses", async () => {
  const f = await attaching();
  await setTool(f, "get_attachment", "allow", f.northwind);
  const extra = await seedAccount({ email: "third@example.com" });
  await setTool(f, "get_attachment", "allow", extra);
  await answer(await attachCall(f, [copy, copy, { ...copy, account: extra.email }]));
  await setTool(f, "get_attachment", "deny", f.northwind);
  await attachCall(f, [copy]);
  await attachCall(f, [{ ...copy, account: "not an address" }]);
  const uploaded = await upload(f);
  await answer(await attachCall(f, [{ upload: uploaded.upload }]));
  const calls = (
    await env.DB.prepare(
      "SELECT tool,also,outcome FROM calls WHERE tool = 'send_message' ORDER BY id",
    ).all<{ also: string | null; outcome: string }>()
  ).results;
  expect(calls.map((call) => (call.also === null ? null : JSON.parse(call.also)))).toEqual([
    [
      { account: f.northwind.id, tool: "get_attachment" },
      { account: extra.id, tool: "get_attachment" },
    ],
    [{ account: f.northwind.id, tool: "get_attachment" }],
    null,
    null,
  ]);
  expect(calls.map((call) => call.outcome)).toEqual(["success", "refused", "refused", "success"]);
  expect(JSON.stringify(calls)).not.toContain(NORTHWIND);
});
it("explains copying files in the connection permission text", async () => {
  const f = await attaching();
  const response = await f.mcp.browser.get(`/connections/${f.connection.id}`);
  const props = JSON.parse(
    /<script id="page-props" type="application\/json">([\s\S]*?)<\/script>/.exec(
      await response.text(),
    )![1]!,
  ) as { tools: Array<{ name: string; description: string }> };
  expect(props.tools.find((tool) => tool.name === "get_attachment")!.description).toBe(
    "Download a file attached to a message of this account, or copy it into mail that this connection writes from any account.",
  );
});

it.each(["message", "attachment", "google", "refresh"])(
  "names the source for a %s failure and lets the same call run after recovery",
  async (kind) => {
    const f = await attaching();
    await setTool(f, "get_attachment", "allow", f.northwind);
    if (kind === "message")
      google.messageAnswers.set(copy.message, () => new Response(null, { status: 404 }));
    if (kind === "attachment") {
      const { filePart, serveAttachment } = await import("./support/uploads");
      serveAttachment({ ...filePart(), partId: "3" });
    }
    if (kind === "google")
      google.messageAnswers.set(copy.message, () => new Response(null, { status: 500 }));
    if (kind === "refresh") {
      await env.DB.prepare("UPDATE accounts SET access_expires_at = 1 WHERE id = ?")
        .bind(f.northwind.id)
        .run();
      google.refreshAnswers.push("invalid_grant");
    }
    await expectError(
      await attachCall(f, [copy]),
      kind === "message" || kind === "attachment"
        ? "not_found"
        : kind === "refresh"
          ? "account_needs_reconnect"
          : "google_unavailable",
      kind === "message"
        ? `No message "${copy.message}" exists in ${NORTHWIND}. A message ID works only in the account that returned it.`
        : kind === "attachment"
          ? `No attachment "2" exists in ${NORTHWIND}. A attachment ID works only in the account that returned it.`
          : kind === "refresh"
            ? `Ask the owner to reconnect ${NORTHWIND} at ${ORIGIN}/accounts.`
            : `Google could not complete the request for ${NORTHWIND}. Try again later.`,
    );
    expect(await onceRows()).toEqual([]);
    noWrites();
    const { serveAttachment } = await import("./support/uploads");
    serveAttachment();
    if (kind === "refresh")
      await env.DB.prepare(
        "UPDATE accounts SET health = 'ready', refresh_token = ?, access_token = ?, access_expires_at = ? WHERE id = ?",
      )
        .bind(
          f.northwind.refresh_token,
          f.northwind.access_token,
          f.northwind.access_expires_at,
          f.northwind.id,
        )
        .run();
    await answer(await attachCall(f, [copy]));
    expect(google.sends).toHaveLength(1);
  },
);

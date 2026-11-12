import { env } from "cloudflare:workers";
import { expect, it } from "vite-plus/test";
import "./support/account-checks";
import { answer, approve, row, rows } from "./support/approvals";
import { dump } from "./support/db";
import { McpClient } from "./support/oauth";
import { rows as connections } from "./support/connections";
import { callRows, fixture, permissionRows, PERSONAL, toolCall } from "./support/permissions";

type Fixture = Awaited<ReturnType<typeof fixture>>;
const change = (f: Fixture, setting: string, tools = ["list_labels", "search_threads"]) =>
  f.mcp.browser.post(`/connections/${f.connection.id}/permissions`, [
    ["account", f.personal.id],
    ["setting", setting],
    ...tools.map((tool): [string, string] => ["tool", tool]),
  ]);
const ask = async (f: Fixture, tool: string, account = PERSONAL) => {
  const value = await answer(
    await toolCall(f.mcp, tool, { account, ...(tool === "search_threads" ? { query: "a" } : {}) }),
  );
  expect(value.status).toBe("pending");
  return value.approval as string;
};

it("sets all named tools, counts duplicate names once, and applies them on the next call", async () => {
  const f = await fixture();
  const response = await change(f, "allow", ["list_labels", "search_threads", "list_labels"]);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ outcome: "ok" });
  expect(await permissionRows()).toEqual([
    { connection_id: f.connection.id, account_id: f.personal.id, tool: "list_labels", ask: 0 },
    { connection_id: f.connection.id, account_id: f.personal.id, tool: "search_threads", ask: 0 },
  ]);
  expect(await answer(await toolCall(f.mcp, "list_labels", { account: PERSONAL }))).toHaveProperty(
    "labels",
  );
  expect(
    await answer(await toolCall(f.mcp, "search_threads", { account: PERSONAL, query: "a" })),
  ).toHaveProperty("threads");
});

it.each([{ tools: [] }, { tools: ["list_labels", "send_everything"] }])(
  "rejects the whole request with tools $tools before storing anything",
  async ({ tools }) => {
    const f = await fixture();
    const before = await dump();
    const response = await change(f, "allow", tools);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ outcome: "invalid" });
    expect(await dump()).toEqual(before);
  },
);

it("rolls back every setting and approval when the second tool's database write aborts", async () => {
  const f = await fixture();
  expect(await (await change(f, "ask")).json()).toEqual({ outcome: "ok" });
  const waiting = await ask(f, "list_labels");
  const before = await dump();
  const approval = await row(waiting);
  await env.DB.prepare(
    "CREATE TRIGGER fail_second_tool BEFORE DELETE ON permissions WHEN OLD.tool = 'search_threads' BEGIN SELECT RAISE(ABORT, 'test rollback'); END",
  ).run();
  const response = await change(f, "deny");
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ outcome: "unknown" });
  expect(await dump()).toEqual(before);
  expect(await row(waiting)).toEqual(approval);
  expect((await callRows())[0]!.outcome).toBe("pending");
});

it("denies both tools, ends their waiting approvals and purges their text without touching other accounts or connections", async () => {
  const f = await fixture();
  expect(await (await change(f, "ask")).json()).toEqual({ outcome: "ok" });
  const finished = await ask(f, "list_labels");
  await approve(f, finished);
  const waiting = await Promise.all([ask(f, "list_labels"), ask(f, "search_threads")]);
  expect((await row(finished))!.result).not.toBeNull();
  const otherMcp = await new McpClient().connect("Other laptop");
  const other = (await connections()).find((c) => c.id !== f.connection.id)!;
  for (const [mcp, connection, account] of [
    [otherMcp, other, f.personal],
    [f.mcp, f.connection, f.northwind],
  ] as const) {
    expect(
      await (
        await mcp.browser.post(`/connections/${connection.id}/permissions`, {
          account: account.id,
          tool: "list_labels",
          setting: "ask",
        })
      ).json(),
    ).toEqual({ outcome: "ok" });
  }
  const untouched = [
    await ask({ ...f, mcp: otherMcp }, "list_labels"),
    await ask(f, "list_labels", f.northwind.email),
  ];
  const before = await rows();
  expect(await (await change(f, "deny")).json()).toEqual({ outcome: "ok" });
  const calls = await callRows();
  for (const id of waiting) {
    const approval = (await row(id))!;
    expect(approval).toMatchObject({
      state: "refused",
      ended_by: "tool",
      arguments: null,
      result: null,
    });
    expect(calls.find((call) => call.id === approval.call_id)!.outcome).toBe("refused");
  }
  expect(await row(finished)).toMatchObject({
    state: "approved",
    outcome: "success",
    arguments: null,
    result: null,
  });
  for (const id of untouched)
    expect(await row(id)).toEqual(before.find((approval) => approval.id === id));
  expect(
    (await permissionRows()).filter(
      (permission) =>
        permission.connection_id === f.connection.id && permission.account_id === f.personal.id,
    ),
  ).toEqual([]);
});

it("leaves an unnamed tool and its waiting approval unchanged", async () => {
  const f = await fixture();
  await change(f, "ask");
  const id = await ask(f, "search_threads");
  const before = await row(id);
  expect(await (await change(f, "deny", ["list_labels"])).json()).toEqual({ outcome: "ok" });
  expect(await permissionRows()).toEqual([
    { connection_id: f.connection.id, account_id: f.personal.id, tool: "search_threads", ask: 1 },
  ]);
  expect(await row(id)).toEqual(before);
});

it.each(["ask", "allow"])(
  "keeps both approvals waiting when both tools are set to %s",
  async (setting) => {
    const f = await fixture();
    await change(f, "ask");
    await ask(f, "list_labels");
    await ask(f, "search_threads");
    const before = await rows();
    expect(await (await change(f, setting)).json()).toEqual({ outcome: "ok" });
    expect(await rows()).toEqual(before);
  },
);

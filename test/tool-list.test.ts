import { env } from "cloudflare:workers";
import { expect, it } from "vite-plus/test";
import { TOOLS } from "../src/mcp/tools";
import { rows } from "./support/connections";
import { clients, McpClient, rpcMessages, rpcResult } from "./support/oauth";
import {
  fixture,
  permission,
  problemCases,
  toolCall,
  expectError,
  refusedMessage,
  PERSONAL,
} from "./support/permissions";
import { statementFailingDb } from "./support/db";
import { testEnv } from "./support/worker";

const plainTools = [
  {
    name: "list_accounts",
    description:
      "Lists the Google accounts this connection can use, as a JSON array. An empty array means the owner has not given this connection access to any account.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: "get_approval",
    description:
      "Returns the state of a call that waits for the owner's approval, and the call's result once the owner approved it. `approval` is the approval ID from the pending answer. Call it after the owner tells you that they decided. It answers at once and never waits for the owner. When the approved call returns a file, the answer has a second part with the file, in the form that get_attachment describes. The status running can also mean that the owner approved and the file is not ready yet. A client that cannot read the file gets attachment_not_readable, and the file stays for the rest of its hour.",
    inputSchema: {
      type: "object",
      properties: { approval: { type: "string" } },
      required: ["approval"],
    },
    annotations: { readOnlyHint: true },
  },
];
const labelsTool = {
  name: "list_labels",
  description:
    "Lists the Gmail labels of one Google account. `account` is the address of an account that list_accounts returns. When the owner sets this tool to ask, it returns a pending approval with a link instead of labels; get_approval returns the labels after the owner approves.",
  inputSchema: expect.objectContaining({
    type: "object",
    properties: { account: { type: "string" } },
    required: ["account"],
  }),
  annotations: { readOnlyHint: true },
};
const names = async (mcp: McpClient) =>
  ((await rpcResult(await mcp.call())).tools as Array<{ name: string }>).map((tool) => tool.name);

it.each(clients)(
  "lists only plain tools for a new $label connection and promises notices",
  async (client) => {
    const mcp = await new McpClient(client).connect();
    expect((await rpcResult(await mcp.call())).tools).toEqual(plainTools);
    expect((await rpcResult(await mcp.call("initialize"))).capabilities).toHaveProperty("tools", {
      listChanged: true,
    });
  },
);

it("lists an allowed or ask-first tool in registry order, and removes it when denied everywhere", async () => {
  const f = await fixture();
  await permission(f);
  expect((await rpcResult(await f.mcp.call())).tools).toEqual([
    plainTools[0],
    labelsTool,
    plainTools[1],
  ]);
  const response = await f.mcp.browser.post(`/connections/${f.connection.id}/permissions`, {
    account: f.personal.id,
    tool: "list_labels",
    setting: "ask",
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ outcome: "ok" });
  expect((await rpcResult(await f.mcp.call())).tools).toEqual([
    plainTools[0],
    labelsTool,
    plainTools[1],
  ]);
  await permission(f, f.personal, false);
  expect((await rpcResult(await f.mcp.call())).tools).toEqual(plainTools);
});

it("lists a tool whose only permitted account needs reconnecting", async () => {
  const f = await fixture(problemCases.find((item) => item.status === "needs_reconnect")!.row);
  await permission(f);
  expect(await names(f.mcp)).toEqual(["list_accounts", "list_labels", "get_approval"]);
});

it("publishes the expected annotations for every tool", async () => {
  const f = await fixture();
  for (const tool of TOOLS)
    if (tool.kind === "account") await permission(f, f.personal, true, tool.name);
  const listed = (await rpcResult(await f.mcp.call())).tools as Array<{
    name: string;
    annotations: unknown;
  }>;
  expect(listed.map(({ name, annotations }) => ({ name, annotations }))).toEqual([
    { name: "list_accounts", annotations: { readOnlyHint: true } },
    { name: "list_labels", annotations: { readOnlyHint: true } },
    { name: "search_threads", annotations: { readOnlyHint: true } },
    { name: "read_thread", annotations: { readOnlyHint: true } },
    { name: "get_attachment", annotations: { readOnlyHint: true } },
    {
      name: "change_labels",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    {
      name: "create_draft",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    { name: "get_approval", annotations: { readOnlyHint: true } },
  ]);
});

it("removes a tool when the owner removes its only permitted account", async () => {
  const f = await fixture();
  await permission(f);
  expect(await names(f.mcp)).toContain("list_labels");
  const response = await f.mcp.browser.post(`/accounts/${f.personal.id}/remove`);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ outcome: "ok" });
  expect((await rpcResult(await f.mcp.call())).tools).toEqual(plainTools);
});

it("an unlisted tool still uses the existing call checks", async () => {
  const f = await fixture();
  expect(await names(f.mcp)).toEqual(["list_accounts", "get_approval"]);
  await expectError(
    await toolCall(f.mcp, "list_labels", { account: 42 }),
    "invalid_arguments",
    /./,
  );
  await expectError(
    await toolCall(f.mcp, "list_labels", { account: PERSONAL }),
    "account_not_available",
    refusedMessage(PERSONAL),
  );
  const { messages } = await rpcMessages(await toolCall(f.mcp, "unknown_tool"));
  expect(messages).toEqual([
    { jsonrpc: "2.0", id: 1, error: { code: -32602, message: "Tool unknown_tool not found" } },
  ]);
});

it("a permission changes only its connection's list", async () => {
  const f = await fixture();
  const other = await new McpClient().connect("Other laptop");
  await permission(f);
  expect(await names(f.mcp)).toEqual(["list_accounts", "list_labels", "get_approval"]);
  expect((await rpcResult(await other.call())).tools).toEqual(plainTools);
  await permission(f, f.personal, false);
  expect((await rpcResult(await other.call())).tools).toEqual(plainTools);
});

it("a failed list read returns an internal error without a list", async () => {
  const f = await fixture();
  await permission(f);
  const { messages } = await rpcMessages(
    await f.mcp.call(
      "tools/list",
      testEnv({
        DB: statementFailingDb(/SELECT json_group_array\(tool\)/),
      }),
    ),
  );
  expect(messages).toEqual([
    {
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32603, message: "The server could not read the tool list. Try again later." },
    },
  ]);
});

it("keeps a tool out of the list of a connection that holds another stored tool on the same account", async () => {
  const f = await fixture();
  await permission(f);
  const other = await new McpClient().connect("Other laptop");
  const otherConnection = (await rows()).find((row) => row.id !== f.connection.id)!;
  // No page can store a second account tool yet, and a stored name the server lacks is not listed.
  await env.DB.prepare("INSERT INTO permissions (connection_id, account_id, tool) VALUES (?, ?, ?)")
    .bind(otherConnection.id, f.personal.id, "another_tool")
    .run();
  expect(await names(f.mcp)).toEqual(["list_accounts", "list_labels", "get_approval"]);
  expect((await rpcResult(await other.call())).tools).toEqual(plainTools);
});

it("returns the same list in revision 2026-07-28, which clients that listen speak", async () => {
  const f = await fixture();
  await permission(f);
  const listed = await rpcResult(
    await f.mcp.call(
      "tools/list",
      undefined,
      {
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
      { "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/list" },
    ),
  );
  expect(listed.tools).toEqual([plainTools[0], labelsTool, plainTools[1]]);
});

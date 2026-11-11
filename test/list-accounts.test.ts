import { TOOLS } from "../src/mcp/tools";
import { expect, it } from "vite-plus/test";
import { seedAccount } from "./support/accounts";
import { clients, McpClient, rpcResult } from "./support/oauth";

it.each(clients)(
  "offers the account tools and get_approval to $label without promising tool list notifications",
  async (client) => {
    const mcp = await new McpClient(client).connect();
    const listed = await rpcResult(await mcp.call("tools/list"));
    expect.soft(listed.tools).toEqual([
      {
        name: "list_accounts",
        description:
          "Lists the Google accounts this connection can use, as a JSON array. An empty array means the owner has not given this connection access to any account.",
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: true },
      },
      {
        name: "list_labels",
        description:
          "Lists the Gmail labels of one Google account. `account` is the address of an account that list_accounts returns.",
        inputSchema: expect.objectContaining({
          type: "object",
          properties: { account: { type: "string" } },
          required: ["account"],
        }),
        annotations: { readOnlyHint: true },
      },
      {
        name: "get_approval",
        description:
          "Returns the state of a call that waits for the owner's approval, and the call's result once the owner approved it. `approval` is the approval ID from the pending answer. Call it after the owner tells you that they decided. It answers at once and never waits for the owner.",
        inputSchema: {
          type: "object",
          properties: { approval: { type: "string" } },
          required: ["approval"],
        },
        annotations: { readOnlyHint: true },
      },
    ]);
    const initialized = await rpcResult(await mcp.call("initialize"));
    expect(initialized.capabilities).toHaveProperty("tools", { listChanged: false });
  },
);

it("returns an empty JSON array as one text item without an error when called without arguments", async () => {
  const mcp = await new McpClient().connect();
  const result = await rpcResult(
    await mcp.call("tools/call", undefined, { name: "list_accounts" }),
  );
  expect(result.content).toEqual([{ type: "text", text: "[]" }]);
  expect(result).not.toHaveProperty("isError");
  expect(result).not.toHaveProperty("structuredContent");
});

it.each([
  { label: "without arguments", params: { name: "list_accounts" } },
  {
    label: "with an account argument",
    params: { name: "list_accounts", arguments: { account: "alex.personal@example.com" } },
  },
])("reveals no connected account without a permission $label", async ({ params }) => {
  const mcp = await new McpClient().connect();
  await seedAccount({ name: "Personal", email: "alex.personal@example.com" });
  await seedAccount({ name: "Northwind", email: "alex@northwind.example" });
  const response = await mcp.call("tools/call", undefined, params);
  const body = await response.clone().text();
  for (const value of [
    "Personal",
    "alex.personal@example.com",
    "Northwind",
    "alex@northwind.example",
  ])
    expect(body).not.toContain(value);
  const result = await rpcResult(response);
  expect(result.content).toEqual([{ type: "text", text: "[]" }]);
});

it("reads optional input schemas from plain tool entries", async () => {
  const tool = TOOLS.find((tool) => tool.name === "list_accounts")!;
  if (tool.kind !== "plain") throw new Error("Expected plain tool");
  const previous = tool.inputSchema;
  const schema = { type: "object" as const, properties: { cursor: { type: "string" } } };
  try {
    tool.inputSchema = schema;
    const mcp = await new McpClient().connect();
    const listed = await rpcResult(await mcp.call("tools/list"));
    expect(listed.tools).toContainEqual(
      expect.objectContaining({ name: "list_accounts", inputSchema: schema }),
    );
  } finally {
    if (previous === undefined) delete tool.inputSchema;
    else tool.inputSchema = previous;
  }
});

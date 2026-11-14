import { expect, it } from "vite-plus/test";
import { seedAccount } from "./support/accounts";
import { McpClient, rpcResult } from "./support/oauth";

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

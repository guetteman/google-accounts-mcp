import { env } from "cloudflare:workers";
import { expect } from "vite-plus/test";
import { seedAccount, type AccountRow } from "./accounts";
import { onlyConnection } from "./connections";
import { requests } from "./network";
import { McpClient, rpcResult } from "./oauth";
import { ORIGIN } from "./worker";

export const PERSONAL = "alex.personal@example.com";
export const NORTHWIND = "alex@northwind.example";
export const SERVER_MESSAGE = "The server could not complete the call. Try again later.";
export const unavailableMessage = (email: string) =>
  `Google could not complete the request for ${email}. Try again later.`;
export const refusedMessage = (input: string) =>
  `No account "${input}" is available to this connection. Call list_accounts to see the accounts you can use.`;
export const problemCases: Array<{ status: string; row: Partial<AccountRow>; message: string }> = [
  {
    status: "needs_reconnect",
    row: {
      health: "needs_reconnect",
      access_token: null,
      refresh_token: null,
      access_expires_at: null,
    },
    message: `Ask the owner to reconnect ${PERSONAL} at ${ORIGIN}/accounts.`,
  },
  {
    status: "blocked_by_admin",
    row: { health: "blocked_by_admin", blocked_until: Date.parse("2030-11-09T12:10:00Z") },
    message: `A Google Workspace admin blocked this server for ${PERSONAL}. The owner can see the details at ${ORIGIN}/accounts.`,
  },
  {
    status: "missing_access",
    row: { scopes: "[]" },
    message: `Google did not grant all the Gmail access this server asks for on ${PERSONAL}. Ask the owner to reconnect it at ${ORIGIN}/accounts and check every box.`,
  },
  {
    status: "unreadable",
    row: { access_token: "v1.wrong-key.x.y", refresh_token: "v1.wrong-key.x.y" },
    message: `The server cannot read its stored access to ${PERSONAL}. Ask the owner to check ${ORIGIN}/accounts.`,
  },
];
export async function fixture(overrides: Partial<AccountRow> = {}) {
  const mcp = await new McpClient().connect("Claude");
  const connection = await onlyConnection();
  const personal = await seedAccount({ name: "Personal", email: PERSONAL, ...overrides });
  const northwind = await seedAccount({
    name: "Northwind",
    email: NORTHWIND,
    created_at: personal.created_at + 1,
  });
  return { mcp, connection, personal, northwind };
}
export async function permission(
  f: Awaited<ReturnType<typeof fixture>>,
  account = f.personal,
  allowed = true,
) {
  const response = await f.mcp.browser.post(`/connections/${f.connection.id}/permissions`, {
    account: account.id,
    tool: "list_labels",
    allowed: String(allowed),
  });
  expect(response.status, "the owner can set a permission through the Worker").toBe(200);
  expect(await response.json()).toEqual({ outcome: "ok" });
}
export const toolCall = (
  mcp: McpClient,
  name: string,
  args?: Record<string, unknown>,
  workerEnv?: Env,
) =>
  mcp.call("tools/call", workerEnv, { name, ...(args === undefined ? {} : { arguments: args }) });
export const textResult = (value: unknown) => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
});
export async function expectError(response: Response, code: string, message: string | RegExp) {
  const result = await rpcResult(response);
  expect(Object.keys(result).sort()).toEqual(["content", "isError"]);
  expect(result.isError).toBe(true);
  const content = result.content as Array<{ type: string; text: string }>;
  expect(content).toHaveLength(1);
  expect(Object.keys(content[0]!).sort()).toEqual(["text", "type"]);
  expect(content[0]!.type).toBe("text");
  const error: unknown = JSON.parse(content[0]!.text);
  expect(error).toEqual({
    code,
    message: typeof message === "string" ? message : expect.stringMatching(message),
  });
  return content[0]!.text;
}
export const googleTraffic = () =>
  requests.filter((url) => /\b(?:googleapis\.com|google\.com)\b/.test(new URL(url).hostname));
export interface CallRow {
  id: number;
  connection_id: string;
  account_id: string | null;
  tool: string | null;
  at: number;
  outcome: string | null;
}
export const callRows = async () =>
  (await env.DB.prepare("SELECT * FROM calls ORDER BY id").all<CallRow>()).results;
export const permissionRows = async () =>
  (await env.DB.prepare("SELECT * FROM permissions ORDER BY connection_id, account_id, tool").all())
    .results;

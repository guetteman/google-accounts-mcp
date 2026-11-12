import { expect, it } from "vite-plus/test";
import "./support/account-checks";
import { rows as approvalRows } from "./support/approvals";
import { rows as connectionRows } from "./support/connections";
import { McpClient } from "./support/oauth";
import {
  callRows,
  expectError,
  fixture,
  googleTraffic,
  NORTHWIND,
  permission,
  PERSONAL,
  problemCases,
  refusedMessage,
  toolCall,
} from "./support/permissions";
import { ORIGIN } from "./support/worker";

// A tool that is deny on an account the connection sees. The connection sees an account when
// at least one tool on it is ask or allow.
type Fixture = Awaited<ReturnType<typeof fixture>>;
const notAllowed = (f: Fixture, tool: string, email = PERSONAL) =>
  `The owner has not allowed ${tool} on ${email} for this connection. The owner can change this at ${ORIGIN}/connections/${f.connection.id}.`;
const set = async (f: Fixture, tool: string, setting: "ask" | "allow", account = f.personal) => {
  const response = await f.mcp.browser.post(`/connections/${f.connection.id}/permissions`, {
    account: account.id,
    tool,
    setting,
  });
  expect(await response.json()).toEqual({ outcome: "ok" });
};

it.each([
  { name: "another tool is allowed on the account", other: "allow" as const, listed: false },
  { name: "another tool is ask on the account", other: "ask" as const, listed: false },
  { name: "the tool is allowed on another account", other: "allow" as const, listed: true },
])(
  "refuses a denied tool on a seen account with tool_not_allowed when $name",
  async ({ other, listed }) => {
    const f = await fixture();
    await set(f, "search_threads", other);
    if (listed) await set(f, "list_labels", "allow", f.northwind);
    const before = googleTraffic().length;
    const calls = (await callRows()).length;
    await expectError(
      await toolCall(f.mcp, "list_labels", { account: PERSONAL }),
      "tool_not_allowed",
      notAllowed(f, "list_labels"),
    );
    expect(googleTraffic().slice(before), "a refused call sends nothing to Google").toEqual([]);
    expect(await approvalRows(), "a refused call asks for no approval").toEqual([]);
    const recorded = (await callRows()).slice(calls);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      connection_id: f.connection.id,
      account_id: f.personal.id,
      tool: "list_labels",
      outcome: "refused",
    });
  },
);

it("checks the input before the tool's setting", async () => {
  const f = await fixture();
  await permission(f);
  await expectError(
    await toolCall(f.mcp, "search_threads", { account: PERSONAL }),
    "invalid_arguments",
    /query/,
  );
});

it("checks the tool's setting before the account's status", async () => {
  const f = await fixture(problemCases.find((c) => c.status === "needs_reconnect")!.row);
  await permission(f);
  const before = googleTraffic().length;
  await expectError(
    await toolCall(f.mcp, "search_threads", { account: PERSONAL, query: "a" }),
    "tool_not_allowed",
    notAllowed(f, "search_threads"),
  );
  expect(googleTraffic().slice(before)).toEqual([]);
});

it("names the address the server stores, whatever case and spaces the agent wrote", async () => {
  const f = await fixture();
  await set(f, "search_threads", "allow");
  await expectError(
    await toolCall(f.mcp, "list_labels", { account: " Alex.Personal@Example.com " }),
    "tool_not_allowed",
    notAllowed(f, "list_labels"),
  );
});

it("keeps an account hidden from a connection when only another connection may use it", async () => {
  const f = await fixture();
  const other = await new McpClient().connect("Other laptop");
  const otherConnection = (await connectionRows()).find((row) => row.id !== f.connection.id)!;
  const granted = await other.browser.post(`/connections/${otherConnection.id}/permissions`, {
    account: f.personal.id,
    tool: "list_labels",
    setting: "allow",
  });
  expect(await granted.json()).toEqual({ outcome: "ok" });
  await set(f, "list_labels", "allow", f.northwind);
  const before = googleTraffic().length;
  const bodies: string[] = [];
  for (const account of [PERSONAL, "nobody@example.com"]) {
    for (const tool of ["list_labels", "search_threads"]) {
      const response = await toolCall(
        f.mcp,
        tool,
        tool === "search_threads" ? { account, query: "a" } : { account },
      );
      const bytes = await response.clone().text();
      await expectError(response, "account_not_available", refusedMessage(account));
      bodies.push(bytes.replaceAll(account, "INPUT"));
    }
  }
  expect(new Set(bodies).size, "a hidden account answers like an unknown address").toBe(1);
  expect(googleTraffic().slice(before)).toEqual([]);
  // The same connection does see Northwind, so a denied tool there gets the other refusal.
  await expectError(
    await toolCall(f.mcp, "search_threads", { account: NORTHWIND, query: "a" }),
    "tool_not_allowed",
    notAllowed(f, "search_threads", NORTHWIND),
  );
});

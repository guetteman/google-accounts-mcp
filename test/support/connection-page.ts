import type { AccountView } from "../../src/accounts/model";
import { parseAccountId } from "../../src/accounts/model";
import { parseConnectionId } from "../../src/connections/model";

export const connectionPage = {
  _tag: "Connection" as const,
  frame: {
    host: "accounts-mcp.example.com",
    ownerEmail: "owner@example.com",
    current: "connections" as const,
  },
  connection: {
    id: parseConnectionId("11111111-1111-4111-8111-111111111111")!,
    name: "Claude",
    appLabel: "Claude",
    status: { kind: "active" as const },
    created: "Nov 1",
    lastUsed: "Never",
    canSee: ["Personal"],
  },
  accounts: [
    {
      id: parseAccountId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")!,
      name: "Personal",
      email: "alex.personal@example.com",
      workspace: false,
      status: { kind: "ready" },
    },
    {
      id: parseAccountId("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")!,
      name: "Northwind",
      email: "alex@northwind.example",
      workspace: true,
      status: { kind: "ready" },
    },
    {
      id: parseAccountId("cccccccc-cccc-4ccc-8ccc-cccccccccccc")!,
      name: "Projects",
      email: "alex.projects@example.com",
      workspace: false,
      status: { kind: "needs_reconnect" },
    },
    {
      id: parseAccountId("dddddddd-dddd-4ddd-8ddd-dddddddddddd")!,
      name: "Fabrikam Holdings International, Finance and Legal Operations",
      email: "alexandra.personal-archive@fabrikam-holdings.example",
      workspace: true,
      status: { kind: "ready" },
    },
  ] satisfies AccountView[],
  tools: [
    {
      name: "list_labels" as const,
      label: "List labels",
      description: "See the names of this account's Gmail labels.",
    },
  ],
  settings: { "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:list_labels": "allow" as const },
  requiredGmailScopes: 5,
};

import type { AccountView } from "../../src/accounts/model";
import { parseAccountId } from "../../src/accounts/model";
import { parseConnectionId } from "../../src/connections/model";
import type { FramePage } from "../../src/pages/page";

type ConnectionPage = Extract<FramePage, { _tag: "Connection" }>;

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
    appLabel: "Claude Code",
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
      group: "Find and read",
      label: "List labels",
      description: "See the names of this account's Gmail labels.",
    },
    {
      name: "search_threads",
      group: "Find and read",
      label: "Search mail",
      description:
        "Find threads with a Gmail search, and see each thread's subject, sender, date, and snippet.",
    },
  ],
  settings: { "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:list_labels": "allow" as const },
  requiredGmailScopes: 5,
} satisfies ConnectionPage;

export const groupedConnectionPage = {
  ...connectionPage,
  tools: [
    { name: "send", label: "Send mail", description: "Send a message.", group: "Send" },
    {
      name: "list_labels",
      label: "List labels",
      description: "See Gmail labels.",
      group: "Find and read",
    },
    { name: "draft", label: "Create draft", description: "Save a draft.", group: "Draft" },
    {
      name: "search_threads",
      label: "Search mail",
      description: "Find threads.",
      group: "Find and read",
    },
  ],
  settings: {
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:list_labels": "allow",
    "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb:list_labels": "allow",
    "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb:search_threads": "ask",
    "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb:draft": "ask",
  },
} satisfies ConnectionPage;

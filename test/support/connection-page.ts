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
      irreversible: false,
      description: "See the names of this account's Gmail labels.",
    },
    {
      name: "search_threads",
      group: "Find and read",
      label: "Search mail",
      irreversible: false,
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
    {
      name: "send",
      label: "Send mail",
      description: "Send a message.",
      group: "Send",
      irreversible: false,
    },
    {
      name: "list_labels",
      label: "List labels",
      description: "See Gmail labels.",
      group: "Find and read",
      irreversible: false,
    },
    {
      name: "draft",
      label: "Create draft",
      description: "Save a draft.",
      group: "Draft",
      irreversible: false,
    },
    {
      name: "search_threads",
      label: "Search mail",
      description: "Find threads.",
      group: "Find and read",
      irreversible: false,
    },
  ],
  settings: {
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:list_labels": "allow",
    "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb:list_labels": "allow",
    "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb:search_threads": "ask",
    "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb:draft": "ask",
  },
} satisfies ConnectionPage;

/**
 * Fixture tools: three whose effect cannot be undone and one, the trash, whose effect can.
 * `delete` stands before the Send tools in the list, and the page shows Send first.
 */
export const irreversibleConnectionPage = {
  ...groupedConnectionPage,
  tools: [
    {
      name: "delete",
      label: "Delete permanently",
      description: "Delete messages for good.",
      group: "Trash and delete",
      irreversible: true,
    },
    ...groupedConnectionPage.tools.map((tool) => ({ ...tool, irreversible: tool.name === "send" })),
    {
      name: "forward",
      label: "Forward message",
      description: "Forward a message.",
      group: "Send",
      irreversible: true,
    },
    {
      name: "trash",
      label: "Move to trash",
      description: "Move messages to the trash.",
      group: "Trash and delete",
      irreversible: false,
    },
  ],
  settings: {
    // Personal: nothing irreversible is Allowed yet, and Send mail waits at Ask first.
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:list_labels": "allow",
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:send": "ask",
    // Northwind: Send mail is already Allowed, so only Delete permanently is left to name.
    "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb:send": "allow",
    // Projects: only Forward message is left to name.
    "cccccccc-cccc-4ccc-8ccc-cccccccccccc:send": "allow",
    "cccccccc-cccc-4ccc-8ccc-cccccccccccc:delete": "allow",
    // Fabrikam: every irreversible tool is already Allowed.
    "dddddddd-dddd-4ddd-8ddd-dddddddddddd:send": "allow",
    "dddddddd-dddd-4ddd-8ddd-dddddddddddd:forward": "allow",
    "dddddddd-dddd-4ddd-8ddd-dddddddddddd:delete": "allow",
  },
} satisfies ConnectionPage;

export const sendConnectionPage = {
  ...connectionPage,
  tools: [
    ...connectionPage.tools,
    {
      name: "send_message",
      label: "Send message",
      description: "Send a new message from this account. A sent message cannot be taken back.",
      group: "Send",
      irreversible: true,
    },
    {
      name: "send_reply",
      label: "Send reply",
      description: "Reply to a message in its thread. A sent reply cannot be taken back.",
      group: "Send",
      irreversible: true,
    },
    {
      name: "forward_message",
      label: "Forward message",
      description: "Forward a message with its attachments. It cannot be taken back.",
      group: "Send",
      irreversible: true,
    },
    {
      name: "send_draft",
      label: "Send draft",
      description: "Send an existing draft as it is in Gmail. It cannot be taken back.",
      group: "Send",
      irreversible: true,
    },
  ],
  settings: {
    ...connectionPage.settings,
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:send_reply": "ask",
  },
} satisfies ConnectionPage;

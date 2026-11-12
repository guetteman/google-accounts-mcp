import type { ApprovalPageProps } from "../approvals/model";
import { GMAIL_SCOPES } from "../google/client";
import { MAX_ITEMS } from "../google/gmail";
import { acceptAuthorize } from "../oauth/clients";
import type { ConnectionView } from "../connections/model";
import type { Page } from "./page";

const connections: ReadonlyArray<ConnectionView> = [
  {
    id: "11111111-1111-4111-8111-111111111111" as ConnectionView["id"],
    name: "Work laptop",
    appLabel: "Claude Code",
    status: { kind: "active" },
    lastUsed: "Nov 9",
    canSee: ["Northwind"],
    created: "Nov 1",
  },
  {
    id: "22222222-2222-4222-8222-222222222222" as ConnectionView["id"],
    name: "Claude",
    appLabel: "Claude",
    status: { kind: "active" },
    lastUsed: "Nov 8",
    canSee: ["Personal", "Projects"],
    created: "Nov 1",
  },
  {
    id: "33333333-3333-4333-8333-333333333333" as ConnectionView["id"],
    name: "ChatGPT",
    appLabel: "ChatGPT",
    status: { kind: "active" },
    lastUsed: "Never",
    canSee: [],
    created: "Nov 1",
  },
  {
    id: "44444444-4444-4444-8444-444444444444" as ConnectionView["id"],
    name: "Old laptop",
    appLabel: "Claude Code",
    status: { kind: "expired", on: "Nov 6" },
    lastUsed: "Aug 8",
    canSee: [],
    created: "Aug 8",
  },
  {
    id: "55555555-5555-4555-8555-555555555555" as ConnectionView["id"],
    name: "Personal laptop",
    appLabel: "Claude Code",
    status: { kind: "revoked", on: "Sep 14" },
    lastUsed: "Sep 14",
    canSee: [],
    created: "Sep 1",
  },
];
const host = "accounts-mcp.example.com";
const permissionAccounts: ReadonlyArray<import("../accounts/model").AccountView> = [
  {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-000000000001" as import("../accounts/model").AccountId,
    name: "Personal",
    email: "alex.personal@example.com",
    workspace: false,
    status: { kind: "ready" },
  },
  {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-000000000002" as import("../accounts/model").AccountId,
    name: "Northwind",
    email: "alex@northwind.example",
    workspace: true,
    status: { kind: "ready" },
  },
  {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-000000000003" as import("../accounts/model").AccountId,
    name: "Projects",
    email: "alex.projects@example.com",
    workspace: false,
    status: { kind: "needs_reconnect" },
  },
  {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-000000000004" as import("../accounts/model").AccountId,
    name: "Fabrikam Holdings International, Finance and Legal Operations",
    email: "alexandra.personal-archive@fabrikam-holdings.example",
    workspace: true,
    status: { kind: "ready" },
  },
];
const connectionPreview = (scenario: string): Page => {
  const accounts = ["no-accounts", "ended-connection"].includes(scenario) ? [] : permissionAccounts;
  const allowed = accounts.filter(
    (_, i) =>
      scenario === "all-allowed" ||
      (["some-allowed", "save-failed"].includes(scenario) && [0, 2].includes(i)),
  );
  return {
    _tag: "Connection",
    ...(scenario === "save-failed"
      ? { permissionNotice: "Couldn't reach the database. Nothing changed. Try again in a minute." }
      : {}),
    frame: { host, ownerEmail: "owner@example.com", current: "connections" },
    connection: {
      ...connections[scenario === "ended-connection" ? 4 : 1]!,
      canSee: allowed.map((a) => a.name),
    },
    accounts,
    settings: Object.fromEntries(
      allowed.flatMap((a, i) =>
        (scenario === "all-allowed" || i === 0
          ? ["list_labels", "search_threads", "create_draft"]
          : ["list_labels"]
        ).map((tool) => [
          `${a.id}:${tool}`,
          scenario !== "all-allowed" && i === 0 ? "ask" : "allow",
        ]),
      ),
    ),
    tools: [
      {
        name: "list_labels",
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
      {
        name: "create_draft",
        group: "Draft",
        label: "Create draft",
        irreversible: false,
        description: "Write a draft, new or as a reply. Nothing is sent.",
      },
    ],
    requiredGmailScopes: GMAIL_SCOPES.length,
  };
};
const approvalBase: ApprovalPageProps = {
  _tag: "Approval",
  id: "aaaaaaaa-aaaa-4aaa-8aaa-000000000010",
  request: {
    connection: { id: connections[0]!.id, name: "Laptop", app: "Claude Code" },
    account: { name: "Personal", email: "alex.personal@example.com", workspace: false },
    tool: {
      label: "List labels",
      action: "list the Gmail labels",
      joiner: "of",
      empty: "This call has no other values. The sentence above is the whole call.",
    },
    notes: [],
    values: [],
  },
  times: {
    asked: "19:15 UTC",
    askedOn: "Nov 10 at 19:15 UTC",
    expires: "20:15 UTC",
    expiresOn: "Nov 10 at 20:15 UTC",
    minutesSinceAsked: 4,
    minutesLeft: 56,
    decidedOn: "Nov 10 at 19:19 UTC",
  },
  state: { kind: "waiting", shown: true, changed: false, digest: "preview" },
};
const approvalPreviews: Readonly<Record<string, ApprovalPageProps>> = {
  "approval-waiting": approvalBase,
  "approval-waiting-long-names": {
    ...approvalBase,
    request: {
      ...approvalBase.request,
      connection: {
        ...approvalBase.request.connection,
        name: "Claude Code on the Fabrikam finance team's shared build machine (do not revoke)",
      },
      account: {
        name: "Fabrikam Holdings International, Finance and Legal Operations",
        email: "alexandra.personal-archive@fabrikam-holdings.example",
        workspace: true,
      },
    },
  },
  "approval-waiting-search": {
    ...approvalBase,
    request: {
      ...approvalBase.request,
      tool: { ...approvalBase.request.tool, label: "Search mail", action: "search the mail" },
      values: [
        {
          name: "Query",
          text: "in:inbox is:unread from:billing@northwind.example newer_than:7d",
          from: "agent",
        },
        { name: "Limit", text: "10", from: "agent" },
        { name: "Page", text: "0a1b2c3d4e5f6a7b8c9d", from: "agent" },
      ],
    },
  },
  "approval-waiting-thread": {
    ...approvalBase,
    request: {
      ...approvalBase.request,
      tool: {
        ...approvalBase.request.tool,
        label: "Read thread",
        action: "read a thread",
        joiner: "in",
      },
      values: [
        { name: "Subject", text: "Re: Invoice 2026-114 for the October work", from: "gmail" },
        { name: "Messages", text: "7", from: "gmail" },
        {
          name: "Last message from",
          text: "Kim Lee (Northwind Billing) <kim.lee@northwind.example>",
          from: "gmail",
        },
        { name: "Last message date", text: "Nov 11, 2026 at 09:41 UTC", from: "gmail" },
        { name: "Starts at", text: "Message 4 of 7", from: "agent" },
      ],
    },
  },

  "approval-waiting-draft": {
    ...approvalBase,
    request: {
      ...approvalBase.request,
      tool: {
        ...approvalBase.request.tool,
        label: "Create draft",
        action: "create a draft",
        joiner: "in",
      },
      values: [
        { name: "To", text: "Sam Lee <sam@example.com>", from: "agent" },
        { name: "Cc", text: "Kim <kim@northwind.example>", from: "agent" },
        { name: "Subject", text: "Notes for Thursday's meeting", from: "agent" },
        { name: "Duplicate", text: "2 (a deliberate copy of an earlier call)", from: "agent" },
        {
          name: "Body",
          text: "Hi Sam,\n\nHere are the notes for our meeting on Thursday. Please review the budget before we meet.\n\nThanks,\nAlex",
          from: "agent",
        },
      ],
    },
  },
  "approval-waiting-reply": {
    ...approvalBase,
    request: {
      ...approvalBase.request,
      tool: {
        ...approvalBase.request.tool,
        label: "Create draft",
        action: "create a draft",
        joiner: "in",
      },
      values: [
        { name: "Answers a message from", text: "Kim Lee <kim@northwind.example>", from: "gmail" },
        { name: "Its subject", text: "Invoice for October", from: "gmail" },
        { name: "Its date", text: "Nov 11, 2026 at 09:41 UTC", from: "gmail" },
        { name: "To", text: "Kim Lee <kim@northwind.example>", from: "gmail" },
        { name: "Subject", text: "Re: Invoice for October", from: "gmail" },
        {
          name: "Body",
          text: "Hi Kim,\n\nThe invoice looks correct. I'll arrange payment on Friday.\n\nThanks,\nAlex",
          from: "agent",
        },
      ],
    },
  },
  "approval-waiting-send": {
    ...approvalBase,
    request: {
      ...approvalBase.request,
      tool: {
        ...approvalBase.request.tool,
        label: "Send message",
        action: "send a message",
        joiner: "from",
      },
      values: [
        { name: "To", text: "Sam Lee <sam@example.com>", from: "agent" },
        { name: "Cc", text: "Kim <kim@northwind.example>", from: "agent" },
        { name: "Bcc", text: "Lee <lee@example.com>", from: "agent" },
        { name: "Subject", text: "Notes for Thursday's meeting", from: "agent" },
        {
          name: "Body",
          text: "Hi Sam,\n\nHere are the notes for Thursday. Please review the budget before we meet.\n\nThanks,\nAlex",
          from: "agent",
        },
      ],
    },
  },
  "approval-waiting-send-reply": {
    ...approvalBase,
    request: {
      ...approvalBase.request,
      tool: {
        ...approvalBase.request.tool,
        label: "Send reply",
        action: "send a reply",
        joiner: "from",
      },
      values: [
        { name: "Answers a message from", text: "Kim Lee <kim@northwind.example>", from: "gmail" },
        { name: "Its subject", text: "Invoice for October", from: "gmail" },
        { name: "Its date", text: "Nov 11, 2026 at 09:41 UTC", from: "gmail" },
        { name: "To", text: "Kim Lee <kim@northwind.example>", from: "gmail" },
        { name: "Subject", text: "Re: Invoice for October", from: "gmail" },
        {
          name: "Body",
          text: "Hi Kim,\n\nThe invoice looks correct. I'll arrange payment on Friday.\n\nThanks,\nAlex",
          from: "agent",
        },
      ],
    },
  },
  "approval-waiting-forward": {
    ...approvalBase,
    request: {
      ...approvalBase.request,
      tool: {
        ...approvalBase.request.tool,
        label: "Forward message",
        action: "forward a message",
        joiner: "from",
      },
      values: [
        { name: "Forwards a message from", text: "Kim Lee <kim@northwind.example>", from: "gmail" },
        { name: "Its subject", text: "Invoice for October", from: "gmail" },
        { name: "Its date", text: "Nov 11, 2026 at 09:41 UTC", from: "gmail" },
        { name: "To", text: "Sam Lee <sam@example.com>", from: "agent" },
        { name: "Subject", text: "Fwd: Invoice for October", from: "gmail" },
        { name: "Attachments", text: "2 files, 128,456 bytes in all", from: "gmail" },
        {
          name: "Attachment 1",
          text: "October invoice.pdf (application/pdf, 125,000 bytes)",
          from: "gmail",
        },
        { name: "Attachment 2", text: "logo.png (image/png, 3,456 bytes)", from: "gmail" },
        { name: "Note", text: "Please arrange payment on Friday.", from: "agent" },
        {
          name: "Forwarded text",
          text: "---------- Forwarded message ---------\nFrom: Kim Lee <kim@northwind.example>\nDate: 2026-11-11T09:41:36Z\nSubject: Invoice for October\nTo: Alex <alex.personal@example.com>\n\nThe invoice for October is attached. Thank you!",
          from: "gmail",
        },
      ],
    },
  },
  "approval-waiting-send-draft": {
    ...approvalBase,
    request: {
      ...approvalBase.request,
      tool: {
        ...approvalBase.request.tool,
        label: "Send draft",
        action: "send a draft",
        joiner: "from",
      },
      notes: [
        {
          text: "This is the draft as it is in Gmail now. It is sent as it is at the moment you approve, also if it changed after this page loaded.",
          warning: true,
        },
      ],
      values: [
        { name: "From", text: "Alex <alex.personal@example.com>", from: "gmail" },
        { name: "To", text: "Sam Lee <sam@example.com>", from: "gmail" },
        { name: "Subject", text: "Notes for Thursday's meeting", from: "gmail" },
        {
          name: "Body",
          text: "Hi Sam,\n\nHere are the notes for Thursday. Please review the budget before we meet.\n\nThanks,\nAlex",
          from: "gmail",
        },
      ],
    },
  },
  "approval-cannot-show": {
    ...approvalBase,
    state: { kind: "waiting", shown: false, changed: false, digest: null },
  },
  "approval-changed": {
    ...approvalBase,
    state: { kind: "waiting", shown: true, changed: true, digest: "changed" },
  },
  ...Object.fromEntries(
    (["running", "succeeded", "unknown", "rejected", "expired"] as const).map((kind) => [
      `approval-${kind}`,
      { ...approvalBase, state: { kind } },
    ]),
  ),
  "approval-failed": {
    ...approvalBase,
    state: {
      kind: "failed",
      message:
        "Google could not complete the request for alex.personal@example.com. Try again later.",
    },
  },
  ...Object.fromEntries(
    (["tool", "connection", "account"] as const).map((by) => [
      `approval-ended-${by}`,
      { ...approvalBase, state: { kind: "ended" as const, by } },
    ]),
  ),
  "approval-unconfirmed": { ...approvalBase, unconfirmed: true },
};
export const previews: Readonly<Record<string, Page>> = {
  ...approvalPreviews,
  "approval-waiting-notes": {
    ...approvalBase,
    request: {
      ...approvalPreviews["approval-waiting-thread"]!.request,
      notes: [
        { text: "This call archives this thread: it leaves the inbox.", warning: false },
        { text: "A deleted message cannot be recovered.", warning: true },
      ],
    },
  },
  "approval-waiting-labels": {
    ...approvalBase,
    request: {
      ...approvalBase.request,
      tool: {
        ...approvalBase.request.tool,
        label: "Change labels",
        action: "add or remove labels on threads",
        joiner: "in",
      },
      notes: [
        { text: "This call archives these threads: they leave the inbox.", warning: false },
        { text: "This call marks these threads as read.", warning: false },
      ],
      values: [
        { name: "Labels to add", text: "Receipts", from: "gmail" },
        { name: "Labels to remove", text: "INBOX\nUNREAD", from: "gmail" },
        { name: "Thread 1 subject", text: "Lunch", from: "gmail" },
        { name: "Thread 1 messages", text: "2", from: "gmail" },
        { name: "Thread 1 last from", text: "Kim Lee <kim@example.com>", from: "gmail" },
        { name: "Thread 1 last date", text: "Nov 11, 2026 at 09:41 UTC", from: "gmail" },
        { name: "Thread 2 ID, not found in this account", text: "19a1b2c3d4e5f6ff", from: "agent" },
        { name: "Thread 3 subject", text: "Receipt", from: "gmail" },
        { name: "Thread 3 messages", text: "1", from: "gmail" },
        { name: "Thread 3 last from", text: "billing@example.com", from: "gmail" },
        { name: "Thread 3 last date", text: "Nov 9, 2026 at 04:53 UTC", from: "gmail" },
      ],
    },
  },
  "approval-waiting-labels-many": {
    ...approvalBase,
    request: {
      ...approvalBase.request,
      tool: {
        ...approvalBase.request.tool,
        label: "Change labels",
        action: "add or remove labels on threads",
        joiner: "in",
      },
      notes: [
        { text: "This call archives these threads: they leave the inbox.", warning: false },
        { text: "This call marks these threads as read.", warning: false },
      ],
      values: [
        { name: "Labels to add", text: "Receipts", from: "gmail" },
        { name: "Labels to remove", text: "INBOX\nUNREAD", from: "gmail" },
        ...Array.from({ length: MAX_ITEMS }, (_, index) => {
          const subjects = [
            "Lunch",
            "Re: Invoice for the October project and additional support hours",
            "Team update",
            "Planning next month's workshop, travel arrangements, and shared notes",
          ];
          const senders = [
            "Sam <sam@example.com>",
            "Kim Lee (Northwind Billing and Customer Accounts) <kim.lee@northwind.example>",
            "Jo <jo@example.com>",
            "The workshop planning team <workshops@fabrikam-holdings.example>",
          ];
          return [
            {
              name: `Thread ${index + 1} subject`,
              text: `${subjects[index % subjects.length]} (${index + 1})`,
              from: "gmail" as const,
            },
            {
              name: `Thread ${index + 1} messages`,
              text: String(index + 1),
              from: "gmail" as const,
            },
            {
              name: `Thread ${index + 1} last from`,
              text: senders[index % senders.length]!,
              from: "gmail" as const,
            },
            {
              name: `Thread ${index + 1} last date`,
              text: "Nov 11, 2026 at 09:41 UTC",
              from: "gmail" as const,
            },
          ];
        }).flat(),
      ],
    },
  },
  ...Object.fromEntries(
    [
      "new-connection",
      "some-allowed",
      "all-allowed",
      "no-accounts",
      "ended-connection",
      "save-failed",
    ].map((scenario) => [`connection-${scenario}`, connectionPreview(scenario)]),
  ),
  "access-refused": { _tag: "AccessRefused", host },
  "access-unavailable": { _tag: "AccessUnavailable" },
  "not-owner": { _tag: "NotOwner", host, address: "someone.else@example.net" },
  mismatch: { _tag: "Mismatch" },
  "setup-incomplete": { _tag: "SetupIncomplete", names: ["ACCESS_AUDIENCE"] },
  "setup-incomplete-two": { _tag: "SetupIncomplete", names: ["OWNER_EMAIL", "ACCESS_ISSUER"] },
  unavailable: { _tag: "Unavailable" },
  accounts: {
    accounts: [
      {
        id: "11111111-1111-4111-8111-111111111111" as import("../accounts/model").AccountId,
        name: "Personal",
        email: "alex.personal@example.com",
        workspace: false,
        status: { kind: "ready" },
      },
      {
        id: "22222222-2222-4222-8222-222222222222" as import("../accounts/model").AccountId,
        name: "Side projects",
        email: "alex.projects@example.com",
        workspace: false,
        status: { kind: "needs_reconnect" },
      },
      {
        id: "33333333-3333-4333-8333-333333333333" as import("../accounts/model").AccountId,
        name: "Work",
        email: "alex@harbor.example",
        workspace: true,
        status: { kind: "blocked_by_admin" },
      },
      {
        id: "44444444-4444-4444-8444-444444444444" as import("../accounts/model").AccountId,
        name: "Research and operations shared inbox",
        email: "research@harbor.example",
        workspace: true,
        status: { kind: "missing_access", granted: 2 },
      },
      {
        id: "55555555-5555-4555-8555-555555555555" as import("../accounts/model").AccountId,
        name: "Recovery",
        email: "recovery@example.com",
        workspace: false,
        status: { kind: "unreadable" },
      },
    ],
    alert: { kind: "reconnected", address: "alex.personal@example.com" },
    _tag: "Accounts",
    requiredGmailScopes: GMAIL_SCOPES.length,
    frame: { host, ownerEmail: "owner@example.com", current: "accounts" },
  },
  "accounts-empty": {
    _tag: "Accounts",
    requiredGmailScopes: GMAIL_SCOPES.length,
    frame: { host, ownerEmail: "owner@example.com", current: "accounts" },
    accounts: [],
    alert: null,
  },
  "client-refused": { _tag: "ClientRefused" },
  "consent-expired": { _tag: "ConsentExpired" },
  ...Object.fromEntries(
    [
      [
        "claude-code",
        "https://claude.ai/oauth/claude-code-client-metadata",
        "http://localhost:3118/callback",
      ],
      [
        "claude",
        "https://claude.ai/oauth/mcp-oauth-client-metadata",
        "https://claude.ai/api/mcp/auth_callback",
      ],
      [
        "chatgpt",
        "https://chatgpt.com/oauth/client.json",
        "https://chatgpt.com/connector_platform_oauth_redirect",
      ],
    ].map(([id, clientId, callback]) => [
      `consent-${id}`,
      {
        _tag: "Consent" as const,
        host,
        ownerEmail: "owner@example.com",
        client: acceptAuthorize(clientId!, callback!)!,
        handle: "preview",
        generation: 1,
      },
    ]),
  ),
  "connections-empty": {
    _tag: "Connections",
    frame: { host, ownerEmail: "owner@example.com", current: "connections" },
    connections: [],
    mcpUrl: `https://${host}/mcp`,
  },
  connections: {
    _tag: "Connections",
    connections,
    mcpUrl: `https://${host}/mcp`,
    frame: { host, ownerEmail: "owner@example.com", current: "connections" },
  },
};

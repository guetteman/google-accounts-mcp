import type { ApprovalPageProps } from "../approvals/model";
import { TOOLS } from "../mcp/tools";
import { GMAIL_SCOPES } from "../google/client";
import { MAX_ITEMS } from "../google/gmail";
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
const permissionTools = TOOLS.filter((tool) => tool.kind === "account").map((tool) => ({
  name: tool.name,
  group: tool.group,
  irreversible: tool.irreversible,
  label: tool.label,
  description: tool.permissionDescription,
}));
const connectionPreview = (scenario: string): Page => {
  const accounts = ["no-accounts", "ended-connection"].includes(scenario) ? [] : permissionAccounts;
  const allowed = accounts.filter((_, i) => scenario === "some-allowed" && [0, 2].includes(i));
  return {
    _tag: "Connection",
    frame: { host, ownerEmail: "owner@example.com", current: "connections" },
    connection: {
      ...connections[scenario === "ended-connection" ? 4 : 1]!,
      canSee: allowed.map((a) => a.name),
    },
    accounts,
    settings: Object.fromEntries(
      allowed.flatMap((a, i) =>
        (i === 0 ? permissionTools.map((tool) => tool.name) : ["list_labels"]).map((tool) => [
          `${a.id}:${tool}`,
          i === 0 ? "ask" : "allow",
        ]),
      ),
    ),
    tools: permissionTools,
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
const attachmentPreview: ApprovalPageProps = {
  ...approvalBase,
  request: {
    ...approvalBase.request,
    tool: {
      ...approvalBase.request.tool,
      label: "Send message",
      action: "send a message",
      joiner: "from",
    },
    also: [
      {
        label: "Download attachment",
        action: "download an attachment",
        joiner: "from",
        name: "Northwind",
        email: "alex@northwind.example",
        workspace: true,
      },
    ],
    notes: [{ text: "A sent message cannot be taken back.", warning: true }],
    values: [
      { name: "To", text: "Kim <kim@northwind.example>", from: "agent" },
      { name: "Subject", text: "Invoice and notes for Friday", from: "agent" },
      { name: "Attachments", text: "2 files, 125,180 bytes in all", from: "agent" },
      {
        name: "Attachment 1 (copied)",
        text: "October invoice.pdf (application/pdf, 125,000 bytes)",
        from: "gmail",
      },
      { name: "Attachment 1 is copied from", text: "alex@northwind.example", from: "agent" },
      { name: "Attachment 1 message from", text: "Sam <sam@example.com>", from: "gmail" },
      { name: "Attachment 1 message subject", text: "Invoice for October", from: "gmail" },
      { name: "Attachment 1 message date", text: "Nov 11, 2026 at 09:41 UTC", from: "gmail" },
      {
        name: "Attachment 2 (sent to a link of this connection)",
        text: "Notes.txt (text/plain, 180 bytes)",
        from: "agent",
      },
      {
        name: "Body",
        text: "Hi Kim,\n\nHere are the invoice and our notes for Friday.\n\nThanks,\nAlex",
        from: "agent",
      },
    ],
  },
};
const approvalPreviews: Readonly<Record<string, ApprovalPageProps>> = {
  "approval-waiting-attachments": attachmentPreview,
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

  "approval-waiting-attachment": {
    ...approvalBase,
    request: {
      ...approvalBase.request,
      tool: {
        ...approvalBase.request.tool,
        label: "Download attachment",
        action: "download an attachment",
        joiner: "from",
      },
      values: [
        { name: "File", text: "menu.pdf", from: "gmail" },
        { name: "Type", text: "application/pdf", from: "gmail" },
        { name: "Size", text: "48,213 bytes", from: "gmail" },
        { name: "From", text: "Sam <sam@example.com>", from: "gmail" },
        { name: "Subject", text: "Lunch", from: "gmail" },
        { name: "Date", text: "Nov 11, 2026 at 09:41 UTC", from: "gmail" },
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
      notes: [{ text: "A sent message cannot be taken back.", warning: true }],
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
      notes: [{ text: "A sent message cannot be taken back.", warning: true }],
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
      notes: [{ text: "A sent message cannot be taken back.", warning: true }],
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
        {
          name: "Not forwarded",
          text: "1 part that is neither text nor a file, such as a calendar invitation",
          from: "gmail",
        },
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
        { name: "From", text: "Alex <alex.personal@example.com>", from: "draft" },
        { name: "To", text: "Sam Lee <sam@example.com>", from: "draft" },
        { name: "Subject", text: "Notes for Thursday's meeting", from: "draft" },
        { name: "Attachments", text: "1 file, 1 byte in all", from: "draft" },
        { name: "Attachment 1", text: "ack.txt (text/plain, 1 byte)", from: "draft" },
        {
          name: "Body",
          text: "Hi Sam,\n\nHere are the notes for Thursday. Please review the budget before we meet.\n\nThanks,\nAlex",
          from: "draft",
        },
      ],
    },
  },
  "approval-waiting-delete": {
    ...approvalBase,
    request: {
      ...approvalBase.request,
      tool: {
        ...approvalBase.request.tool,
        label: "Delete permanently",
        action: "delete messages permanently",
        joiner: "from",
      },
      notes: [
        {
          text: "These messages cannot be recovered. They do not go to the trash: Gmail deletes them at once and for good.",
          warning: true,
        },
      ],
      values: [
        {
          name: "Message 1 from",
          text: "Kim Lee (Northwind Billing) <kim.lee@northwind.example>",
          from: "gmail",
        },
        {
          name: "Message 1 subject",
          text: "Invoice 2026-114 for the October work",
          from: "gmail",
        },
        { name: "Message 1 date", text: "Nov 11, 2026 at 09:41 UTC", from: "gmail" },
        { name: "Message 2 from", text: "Sam Ortiz <sam@example.com>", from: "gmail" },
        {
          name: "Message 2 subject",
          text: "Re: Invoice 2026-114 for the October work",
          from: "gmail",
        },
        { name: "Message 2 date", text: "Nov 11, 2026 at 10:15 UTC", from: "gmail" },
        {
          name: "Message 3 ID, not found in this account",
          text: "19a1b2c3d4e5f603",
          from: "agent",
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
  "approval-unknown-send": {
    ...approvalBase,
    request: {
      ...approvalBase.request,
      tool: {
        ...approvalBase.request.tool,
        label: "Send message",
        action: "send a message",
        joiner: "from",
      },
    },
    state: {
      kind: "unknown",
      message:
        "The server does not know whether this mail went out from alex.personal@example.com. Ask the owner to look in Sent. If it is not there, it may still be in Drafts, and the owner can send it from Gmail. Until 2026-11-17T19:19:00Z, repeating this call does not send it again. Only if the owner says that it is in neither place, call again with duplicate: 2.",
    },
  },
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
const activityConnections: ReadonlyArray<import("../activity/store").ActivityConnection> = [
  ...connections.map(({ id, name, appLabel, status }) => ({ id, name, appLabel, status })),
  {
    id: "66666666-6666-4666-8666-666666666666" as ConnectionView["id"],
    name: "Claude Code on the Fabrikam finance team's shared build machine",
    appLabel: "Claude Code",
    status: { kind: "active" },
  },
];
const activityAccounts: ReadonlyArray<import("../activity/store").ActivityAccount> = [
  ...permissionAccounts.map(({ id, name, email }) => ({ id, name, email, removedOn: null })),
  {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-000000000005" as import("../accounts/model").AccountId,
    name: "Studio",
    email: "alex@oldwork.example",
    removedOn: "Oct 20",
  },
];
const activityTime = (at: number): import("../activity/store").ActivityRecord["time"] => {
  const iso = new Date(at).toISOString();
  const clock = iso.slice(11, 16);
  const today = iso.startsWith("2026-11-13");
  const date = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    ...(new Date(at).getUTCFullYear() === 2026 ? {} : { year: "numeric" }),
    timeZone: "UTC",
  }).format(at);
  const fullDate = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(at);
  return {
    iso,
    short: today ? clock : `${date}, ${clock}`,
    full: `${fullDate} at ${clock} UTC`,
    today,
  };
};
const activityRecord = (
  id: number,
  outcome: import("../activity/store").ActivityRecord["outcome"],
  tool: string | null = "read_thread",
  account = 0,
  connection = 0,
  at = Date.UTC(2026, 10, 13, 14, 21) - (100 - id) * 43 * 60_000,
): import("../activity/store").ActivityRecord => {
  const definition = TOOLS.find((t) => t.name === tool);
  return {
    id: id as import("../calls/store").CallId,
    outcome,
    reason: null,
    tool: definition
      ? { name: definition.name, label: definition.label, kind: definition.kind }
      : null,
    account: account < 0 ? null : activityAccounts[account]!,
    connection: activityConnections[connection]!,
    also: [],
    time: activityTime(at),
    approval:
      outcome === "pending" ? { id: approvalBase.id, state: "waiting", decidedOn: null } : null,
  };
};
const activityRecords: ReadonlyArray<import("../activity/store").ActivityRecord> = [
  activityRecord(100, "pending", "send_message"),
  {
    ...activityRecord(99, "success", "send_message", 0, 1),
    also: [
      {
        account: activityAccounts[1]!,
        tool: { name: "get_attachment", label: "Download attachment" },
      },
    ],
  },
  {
    ...activityRecord(98, "refused", "delete_messages", 1),
    reason: "Tool not allowed",
  },
  {
    ...activityRecord(97, "failed", "search_threads", 2),
    reason: "Account needs reconnect",
  },
  {
    ...activityRecord(96, "rejected", "trash_messages"),
    approval: {
      id: approvalBase.id,
      state: "rejected",
      decidedOn: "Fri, Nov 13, 2026 at 11:34 UTC",
    },
  },
  activityRecord(95, "expired", "send_reply", 1, 2),
  activityRecord(94, "unknown", "create_draft", 3, 5),
  activityRecord(93, "repeat", "send_message"),
  activityRecord(92, "success", "list_accounts", -1),
  activityRecord(91, "refused", "read_thread", -1),
  activityRecord(90, "refused", null, -1),
  activityRecord(89, "success", "get_approval", -1),
  activityRecord(88, "success", "create_upload_link", -1),
  activityRecord(87, "success", "list_labels", 4, 3),
  {
    ...activityRecord(86, "refused", "change_labels", 4, 4),
    reason: "You set a tool to Not allowed while it waited",
    approval: { id: approvalBase.id, state: "refused", decidedOn: null },
  },
  ...Array.from({ length: 10 }, (_, i) =>
    activityRecord(85 - i, "success", "read_thread", i % 4, i % 3),
  ),
];
const activityOlderRecords = Array.from({ length: 25 }, (_, i) => {
  const [outcome, tool] = (
    [
      ["success", "search_threads"],
      ["refused", "change_labels"],
      ["failed", "create_draft"],
      ["expired", "send_message"],
      ["repeat", "send_reply"],
      ["unknown", "read_thread"],
    ] as const
  )[i % 6]!;
  return activityRecord(
    75 - i,
    outcome,
    tool,
    i % 5,
    i % activityConnections.length,
    i === 24 ? Date.UTC(2025, 11, 31, 16, 38) : Date.UTC(2026, 10, 12, 18, 7) - i * 7 * 3_600_000,
  );
});
const activityPreview = (scenario: string): Page => {
  const filter: import("../activity/store").ActivityFilter | null =
    scenario === "pending"
      ? { kind: "outcome", outcome: "pending" }
      : scenario === "account"
        ? { kind: "account", id: activityAccounts[1]!.id }
        : scenario === "ended"
          ? { kind: "connection", id: activityConnections[3]!.id }
          : scenario === "no-match"
            ? { kind: "outcome", outcome: "failed" }
            : null;
  const records =
    scenario === "empty" || scenario === "no-match"
      ? []
      : scenario === "older"
        ? activityOlderRecords
        : scenario === "pending"
          ? activityRecords.filter((r) => r.outcome === "pending")
          : scenario === "account"
            ? activityRecords.filter(
                (r) =>
                  r.account?.id === activityAccounts[1]!.id ||
                  r.also.some((a) => a.account.id === activityAccounts[1]!.id),
              )
            : scenario === "ended"
              ? activityRecords.filter((r) => r.connection.id === activityConnections[3]!.id)
              : activityRecords;
  return {
    _tag: "Activity",
    frame: { host, ownerEmail: "owner@example.com", current: "activity" },
    query: {
      filter,
      before: scenario === "older" ? (76 as import("../calls/store").CallId) : null,
    },
    load: {
      records,
      connections: scenario === "empty" ? [] : activityConnections,
      accounts: scenario === "empty" ? [] : activityAccounts,
      older: scenario === "activity" ? (76 as import("../calls/store").CallId) : null,
    },
  };
};

export const previews: Readonly<Record<string, Page>> = {
  ...Object.fromEntries(
    ["activity", "older", "pending", "account", "ended", "no-match", "empty"].map((scenario) => [
      scenario === "activity" ? "activity" : `activity-${scenario}`,
      activityPreview(scenario),
    ]),
  ),
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
    ["some-allowed", "no-accounts", "ended-connection"].map((scenario) => [
      `connection-${scenario}`,
      connectionPreview(scenario),
    ]),
  ),
  "access-refused": { _tag: "AccessRefused", host },
  "access-unavailable": { _tag: "AccessUnavailable" },
  "not-owner": { _tag: "NotOwner", host, address: "someone.else@example.net" },
  mismatch: { _tag: "Mismatch" },
  "setup-incomplete": { _tag: "SetupIncomplete", names: ["ACCESS_AUDIENCE"] },
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
  "consent-expired": { _tag: "ConsentExpired" },
  connections: {
    _tag: "Connections",
    connections,
    mcpUrl: `https://${host}/mcp`,
    frame: { host, ownerEmail: "owner@example.com", current: "connections" },
  },
};

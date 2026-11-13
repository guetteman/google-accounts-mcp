import {
  Attachments,
  alsoOf,
  uploadsOf,
  attachingTools,
  attachmentValues,
  attachedFiles,
  attachmentsDescription,
  attachmentsExpect,
  type Item,
} from "./attachments";
import { createLink } from "../uploads/store";
import { UPLOAD_PATH } from "../uploads/link";
import type { Tool as McpTool } from "@modelcontextprotocol/server";
import { isoSeconds, viewDate, type ViewNote, type ViewValue } from "../approvals/model";
import { getApproval } from "../approvals/result";
import { Data, Effect, Result, Schema, SchemaIssue } from "effect";
import type { Unavailable } from "../db";
import { accountMessage } from "../accounts/model";
import { listVisibleAccounts } from "../accounts/store";
import { findAttachment, partBytes } from "../google/attachment";
import { MAX_ATTACHMENT_BYTES, WithFile, type Takes } from "./file";
import { BodyBudget, LIMIT, placeOf, readThread, textOf } from "../google/thread";
import { listLabels, MAX_ITEMS, searchThreads, threadSummary } from "../google/gmail";
import {
  changeLabels,
  labelChangeNotes,
  labelChangeValues,
  LABELS_EXPECT,
  MAX_LABELS,
  REFUSED,
  REFUSED_ADD,
} from "../google/organize";
import { deleteMessages, messageValues, restoreMessages, trashMessages } from "../google/trash";
import { readListedTools } from "../permissions/store";
import type { CallContext } from "./call";
import {
  creating,
  notSendable,
  messageTooLarge,
  notReadable,
  tooLarge,
  ToolFailure,
} from "./failures";
import type { Group } from "./groups";
import type { Created } from "../once/store";
import { createDraft, readDraft, uploadDraft } from "../google/draft";
import {
  MAX_SUBJECT,
  mailboxText,
  messageText,
  parseMailbox,
  rawMessage,
  mixedMessage,
  type Mailbox,
  type Outgoing,
} from "../google/mail";
import { replyPlan, type ReplyPlan } from "../google/reply";
import { normalizeEmail } from "../owner/owner";
import {
  MAX_BODY_PARTS,
  MAX_REPLY_HEADER,
  MAX_TEXT,
  PAGE_BODY_BYTES,
  shorten,
} from "../google/bounds";
import { sendExisting, sendStaged } from "../google/send";
import { forwardFiles, forwardPlan, MAX_FORWARD_FILES, MAX_FORWARD_BYTES } from "../google/forward";
import { addresses, header, readMessage, attachmentParts, otherParts } from "../google/message";
type AccountExecution<A> =
  | {
      run: (
        send: Send,
        account: { email: string },
        args: A,
        takes: Takes,
      ) => Effect.Effect<unknown, ToolFailure>;
      create?: never;
      unknown?: never;
    }
  | {
      create: (
        send: Send,
        account: { email: string },
        args: A,
        confirm: Confirm,
        sources: Sources,
      ) => Effect.Effect<Created, ToolFailure>;
      defaults: Readonly<Partial<A>>;
      unknown: (email: string, until: number, args: A) => string;
      run?: never;
    };
export class ViewUnavailable extends Data.TaggedError("ViewUnavailable") {}
/** What every tool with a setting takes. A tool reads its own fields through its typed definition. */
export type DecodedArgs = { readonly account: string };
/** A name that the tool list accepted. The list below is the only list of tool names. */
export type AccountTool = string & { readonly __accountTool: unique symbol };
/** Tools supply a request, never receive a credential or token store. */
export type Send = (
  build: (accessToken: string, signal: AbortSignal) => Request,
) => Effect.Effect<Response, ToolFailure>;
export interface Uploaded {
  filename: string;
  type: string;
  size: number;
  charset?: string | null;
  bytes: Effect.Effect<Uint8Array<ArrayBuffer>, ToolFailure>;
}
export interface Sources {
  from: (account: string) => Send;
  uploads: ReadonlyMap<string, Uploaded>;
}
export type Sending = Send & { readonly __sending: unique symbol };
export type Confirm = { readonly check: Effect.Effect<Sending, ToolFailure>; readonly late: Send };
/** What tools/list tells a client about a tool. A tool that changes mail says so. */
export type ToolAnnotations =
  | { readOnlyHint: true }
  | { readOnlyHint: false; destructiveHint: boolean; idempotentHint: boolean };
export type Tool =
  | {
      kind: "plain";
      name: "list_accounts" | "get_approval" | "create_upload_link";
      label: string;
      inputSchema?: McpTool["inputSchema"];
      description: string;
      annotations: ToolAnnotations;
      run: (
        ctx: CallContext,
        args: Record<string, unknown> | undefined,
      ) => Effect.Effect<unknown, Unavailable | ToolFailure>;
    }
  | ({
      kind: "account";
      name: AccountTool;
      label: string;
      group: Group;
      /**
       * True when neither the owner nor another tool can revert what one call did: a sent mail, a
       * message deleted for good. False when it can be reverted: a draft can be deleted, and a
       * message in the trash can be restored for 30 days. The connection's page names the tools
       * that say true before it sets them to Allowed.
       */
      irreversible: boolean;
      permissionDescription: string;
      description: string;
      annotations: ToolAnnotations;
      input: Schema.Codec<DecodedArgs, unknown>;
      /** What each field must be, for the message of invalid_arguments. */
      expects: Readonly<Record<string, string>>;
      also?: (args: DecodedArgs) => ReadonlyArray<{ account: string; tool: string }>;
      uploads?: (args: DecodedArgs) => ReadonlyArray<string>;
      view: {
        action: string;
        joiner: string;
        empty: string;
        /** Only send_draft may disable the digest equality check and send the current Gmail draft. */
        asItIs?: true;
        /** Sentences that the page says about this call, from its arguments alone. */
        notes?: (args: DecodedArgs) => ReadonlyArray<ViewNote>;
        values: (
          args: DecodedArgs,
          send: Send,
          sources: Sources,
        ) => Effect.Effect<ReadonlyArray<ViewValue>, ViewUnavailable | ToolFailure>;
      };
    } & AccountExecution<DecodedArgs>);
type AccountDefinition<A extends DecodedArgs> = {
  name: string;
  label: string;
  group: Group;
  irreversible: boolean;
  permissionDescription: string;
  description: string;
  annotations: ToolAnnotations;
  input: Schema.Codec<A, unknown>;
  expects: Readonly<Record<keyof A & string, string>>;
  also?: (args: A) => ReadonlyArray<{ account: string; tool: string }>;
  uploads?: (args: A) => ReadonlyArray<string>;
  view: {
    action: string;
    joiner: string;
    empty: string;
    /** Only send_draft may disable the digest equality check and send the current Gmail draft. */
    asItIs?: true;
    /** Sentences that the page says about this call, from its arguments alone. */
    notes?: (args: A) => ReadonlyArray<ViewNote>;
    values: (
      args: A,
      send: Send,
      sources: Sources,
    ) => Effect.Effect<ReadonlyArray<ViewValue>, ViewUnavailable | ToolFailure>;
  };
} & AccountExecution<A>;
// The runner passes a tool only the arguments that the tool's own input decoded.
const accountTool = <A extends DecodedArgs>(definition: AccountDefinition<A>) =>
  ({ kind: "account", ...definition }) as unknown as Extract<Tool, { kind: "account" }>;
/** The field that fails a tool's input, or null when the arguments are not an object. */
export const decodeArgs = (
  tool: Extract<Tool, { kind: "account" }>,
  args: unknown,
): { ok: true; value: DecodedArgs } | { ok: false; field: string | null; expects?: string } => {
  const result = Schema.decodeUnknownResult(tool.input, {
    onExcessProperty: tool.create ? "error" : "ignore",
  })(args);
  if (Result.isSuccess(result)) return { ok: true, value: result.success };
  let issue: unknown = result.failure.issue;
  while (typeof issue === "object" && issue !== null) {
    if ("path" in issue && Array.isArray(issue.path) && typeof issue.path[0] === "string") {
      const extra =
        "issue" in issue &&
        SchemaIssue.isIssue(issue.issue) &&
        issue.issue._tag === "UnexpectedKey";
      return {
        ok: false,
        field: issue.path[0],
        ...(extra ? { expects: "left out: this tool has no such field" } : {}),
      };
    }
    issue =
      "issues" in issue && Array.isArray(issue.issues)
        ? issue.issues[0]
        : "issue" in issue
          ? issue.issue
          : null;
  }
  return { ok: false, field: null };
};
export const DEFAULT_LIMIT = 10;
export const MAX_LIMIT = 25;
const MAX_QUERY = 2000;
const MAX_PAGE = 500;
const ThreadId = Schema.String.check(
  Schema.isBetweenLength(1, 64),
  Schema.isPattern(/^[A-Za-z0-9_-]+$/),
);
const LabelIds = Schema.Array(
  Schema.String.check(
    Schema.isBetweenLength(1, 100),
    Schema.isPattern(/^[A-Za-z0-9_-]+$/),
    Schema.makeFilter((id) => !REFUSED.has(id)),
  ),
).check(Schema.isMaxLength(MAX_LABELS));
const labelChange = (args: {
  threads: readonly string[];
  add?: readonly string[];
  remove?: readonly string[];
}) => ({ threads: args.threads, add: args.add ?? [], remove: args.remove ?? [] });
const Mailboxes = Schema.Array(
  Schema.String.check(Schema.makeFilter((value) => parseMailbox(value) !== null)),
);
const Subject = Schema.String.check(
  Schema.isMaxLength(MAX_SUBJECT),
  // oxlint-disable-next-line no-control-regex -- Input subjects cannot contain header controls.
  Schema.isPattern(/^[^\u0000-\u001f\u007f]*$/),
);
const MessageId = Schema.String.check(
  Schema.isBetweenLength(1, 64),
  Schema.isPattern(/^[A-Za-z0-9_-]+$/),
);
const DraftInput = Schema.Struct({
  account: Schema.String,
  to: Schema.optionalKey(Mailboxes),
  cc: Schema.optionalKey(Mailboxes),
  bcc: Schema.optionalKey(Mailboxes),
  subject: Schema.optionalKey(Subject),
  body: Schema.String,
  attachments: Schema.optionalKey(Attachments),
  reply_to: Schema.optionalKey(
    Schema.String.check(Schema.isBetweenLength(1, 64), Schema.isPattern(/^[A-Za-z0-9_-]+$/)),
  ),
  reply_all: Schema.optionalKey(Schema.Boolean),
  duplicate: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 2, maximum: 100 }))),
}).check(
  Schema.makeFilter((args) => {
    if (
      args.reply_all &&
      (!args.reply_to || [args.to, args.cc, args.bcc].some((list) => list?.length))
    )
      return { path: ["reply_all"], issue: "requires reply_to and no given recipients" };
    if (args.reply_to && args.subject)
      return { path: ["subject"], issue: "cannot be given for a reply" };
    return true;
  }),
);
type DraftArgs = typeof DraftInput.Type;
const draftRecipients = (args: Pick<DraftArgs, "to" | "cc" | "bcc">) => ({
  to: (args.to ?? []).map((text) => parseMailbox(text)!),
  cc: (args.cc ?? []).map((text) => parseMailbox(text)!),
  bcc: (args.bcc ?? []).map((text) => parseMailbox(text)!),
});
const givenRecipients = (boxes: { to: Mailbox[]; cc: Mailbox[]; bcc: Mailbox[] }) =>
  boxes.to.length || boxes.cc.length || boxes.bcc.length ? boxes : null;
const draftMail = (
  args: Pick<DraftArgs, "body" | "subject">,
  boxes: ReturnType<typeof draftRecipients>,
  plan?: ReplyPlan,
): Outgoing => ({
  ...boxes,
  ...(plan
    ? { to: plan.to, cc: plan.cc, inReplyTo: plan.inReplyTo, references: plan.references }
    : {}),
  subject: plan?.subject ?? args.subject ?? "",
  body: args.body,
});
const MessagesInput = Schema.Struct({
  account: Schema.String,
  messages: Schema.Array(
    Schema.String.check(Schema.isBetweenLength(1, 64), Schema.isPattern(/^[A-Za-z0-9_-]+$/u)),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(MAX_ITEMS), Schema.isUnique()),
});
const messagesExpects = {
  account: "a string",
  messages: `a list of 1 to ${MAX_ITEMS} different message IDs that read_thread returned`,
};

const draftValues = (
  args: { body: string; duplicate?: number },
  mail: Outgoing,
  boxes: ReturnType<typeof draftRecipients>,
  plan?: ReplyPlan,
  files: readonly ViewValue[] = [],
): ViewValue[] => {
  const values: ViewValue[] = [];
  if (plan) {
    values.push(
      {
        name: "Answers a message from",
        text: shorten(plan.answered.from, 1000),
        from: "gmail",
      },
      { name: "Its subject", text: shorten(plan.answered.subject, 1000), from: "gmail" },
      { name: "Its date", text: viewDate(plan.answered.date), from: "gmail" },
    );
  }
  for (const [name, recipients] of [
    ["To", mail.to],
    ["Cc", mail.cc],
    ["Bcc", mail.bcc],
  ] as const)
    if (recipients.length)
      values.push({
        name,
        text: recipients.map(mailboxText).join(", "),
        from: plan && !givenRecipients(boxes) ? "gmail" : "agent",
      });
  if (mail.subject)
    values.push({ name: "Subject", text: mail.subject, from: plan ? "gmail" : "agent" });
  values.push(...files);
  if (args.duplicate !== undefined)
    values.push({
      name: "Duplicate",
      text: `${args.duplicate} (a deliberate copy of an earlier call)`,
      from: "agent",
    });
  values.push({ name: "Body", text: args.body, from: "agent" });
  return values;
};

const draftExpects = {
  attachments: attachmentsExpect,
  account: "a string",
  to: "a list of mailboxes, empty or absent when reply_all is true",
  cc: "a list of mailboxes, empty or absent when reply_all is true",
  bcc: "a list of mailboxes, empty or absent when reply_all is true",
  subject: `a string of at most ${MAX_SUBJECT} characters without control characters, empty or absent for a reply`,
  body: "a string",
  reply_to:
    "a message ID of 1 to 64 letters, digits, hyphens, or underscores from this account; a reply requires an empty or absent subject",
  reply_all: "a boolean, true only with reply_to and no given recipients",
  duplicate: "a whole number from 2 to 100",
};

const repeatSend =
  "Repeating: a call with the same arguments as a call of the last 7 days is the same call. It never sends a second message. It returns the first call's result with repeat_of, or its pending approval. So when you get no answer or an error that says to try again, call again with exactly the same arguments. Copy them; do not reword the text, because changed text is a new message. When the answer says that the outcome is unknown, do not try another wording: ask the owner to look in Gmail.";
const deliberateSend =
  " To send one more message with the same content on purpose, add duplicate: 2 (then 3).";
const unknownSend = (
  email: string,
  until: number,
  args: { duplicate?: number; attachments?: readonly Item[] },
) => {
  const next = (args.duplicate ?? 1) + 1;
  return `The server does not know whether this mail went out from ${email}. Ask the owner to look in Sent. If it is not there, it may still be in Drafts, and the owner can send it from Gmail. Until ${isoSeconds(until)}, repeating this call does not send it again.${next <= 100 ? ` Only if the owner says that it is in neither place, call again with duplicate: ${next}${uploadsOf(args.attachments).length ? " and a new upload of each file" : ""}.` : ""}`;
};
const sendRefused = (status: number) =>
  status === 400 ? notSendable(null) : new ToolFailure({ code: "google_unavailable" });
const composedDraft = (
  send: Send,
  mail: Outgoing,
  items: readonly Item[] | undefined,
  sources: Sources,
  thread?: string,
  refused?: (status: number) => ToolFailure,
) =>
  Effect.gen(function* () {
    if (!items?.length)
      return createDraft(
        send,
        { raw: rawMessage(messageText(mail)), ...(thread ? { thread } : {}) },
        refused,
      );
    const files = yield* attachedFiles(
      items,
      sources,
      new TextEncoder().encode(mail.body).byteLength,
    );
    return uploadDraft(send, {
      message: mixedMessage(mail, files),
      ...(thread ? { thread } : {}),
    });
  });
const sendMail = (
  send: Send,
  confirm: Confirm,
  mail: Outgoing,
  items: readonly Item[] | undefined,
  sources: Sources,
  thread?: string,
) =>
  composedDraft(send, mail, items, sources, thread, sendRefused).pipe(
    Effect.flatMap((stage) => sendStaged(confirm, stage)),
  );
const replyExpects =
  "a message whose recipients the server can fill in. For this one, create a draft with create_draft, reply_to, and the recipients, and send it with send_draft";
const sendReplyPlan = (
  send: Send,
  args: { account: string; message: string; reply_all?: boolean },
) =>
  replyPlan(send, {
    account: normalizeEmail(args.account)!,
    message: args.message,
    all: args.reply_all ?? false,
    given: null,
  }).pipe(
    Effect.mapError((failure) =>
      failure.code === "invalid_arguments" && failure.field?.name === "to"
        ? new ToolFailure({
            code: "invalid_arguments",
            field: { name: "message", expects: replyExpects },
          })
        : failure,
    ),
  );
/** Every draft attachment is listed on the page; keep that complete list readable. */
const MAX_DRAFT_FILES = 20;
const MAX_DRAFT_HEADERS = 20_000;
const fileValues = (
  files: ReadonlyArray<{ filename: string; type: string; size: number }>,
): ViewValue[] => {
  if (!files.length) return [];
  const bytes = files.reduce((n, file) => n + file.size, 0);
  return [
    {
      name: "Attachments",
      text: `${files.length} ${files.length === 1 ? "file" : "files"}, ${bytes.toLocaleString("en-US")} ${bytes === 1 ? "byte" : "bytes"} in all`,
      from: "gmail",
    },
    ...files.map((file, i) => ({
      name: `Attachment ${i + 1}`,
      text: `${file.filename || "(no name)"} (${file.type}, ${file.size.toLocaleString("en-US")} ${file.size === 1 ? "byte" : "bytes"})`,
      from: "gmail" as const,
    })),
  ];
};
const duplicateValue = (duplicate?: number): ViewValue[] =>
  duplicate === undefined
    ? []
    : [
        {
          name: "Duplicate",
          text: `${duplicate} (a deliberate copy of an earlier call)`,
          from: "agent",
        },
      ];
const forwardBody = (quoted: string, note?: string) => (note ? `${note}\n\n${quoted}` : quoted);
const draftNote =
  "This is the draft as it is in Gmail now. It is sent as it is at the moment you approve, also if it changed after this page loaded.";

export const TOOLS: ReadonlyArray<Tool> = [
  {
    kind: "plain",
    name: "list_accounts",
    label: "List accounts",
    annotations: { readOnlyHint: true },
    description:
      "Lists the Google accounts this connection can use, as a JSON array. An empty array means the owner has not given this connection access to any account.",
    run: (ctx) =>
      listVisibleAccounts(ctx).pipe(
        Effect.map((accounts) =>
          accounts.map((a) => ({
            account: a.email,
            name: a.name,
            services: {
              gmail: {
                status: a.status.kind,
                ...(a.status.kind === "ready"
                  ? {}
                  : { message: accountMessage(a.status.kind, a.email, ctx.origin) }),
              },
            },
          })),
        ),
      ),
  },
  accountTool({
    name: "list_labels",
    annotations: { readOnlyHint: true },
    group: "Find and read",
    irreversible: false,
    label: "List labels",
    permissionDescription: "See the names of this account's Gmail labels.",
    description:
      "Lists the Gmail labels of one Google account. `account` is the address of an account that list_accounts returns. When the owner sets this tool to ask, it returns a pending approval with a link instead of labels; get_approval returns the labels after the owner approves.",
    input: Schema.Struct({ account: Schema.String }),
    expects: { account: "a string" },
    view: {
      action: "list the Gmail labels",
      joiner: "of",
      empty: "This call has no other values. The sentence above is the whole call.",
      values: () => Effect.succeed([]),
    },
    run: (send, account) =>
      listLabels(send).pipe(Effect.map((labels) => ({ account: account.email, labels }))),
  }),
  accountTool({
    name: "search_threads",
    annotations: { readOnlyHint: true },
    group: "Find and read",
    irreversible: false,
    label: "Search mail",
    permissionDescription:
      "Find threads with a Gmail search, and see each thread's subject, sender, date, and snippet.",
    description: `Searches the mail of one Google account and returns its threads, newest first. \`account\` is the address of an account that list_accounts returns; to search every account, call this tool once for each of them. \`query\` uses the syntax of Gmail's search box, for example \`in:inbox is:unread\` for unread inbox mail or \`from:alex subject:invoice\`. A search leaves out Spam and Trash unless the query names them, as \`in:trash\` does. \`limit\` is the largest number of threads, ${DEFAULT_LIMIT} by default and ${MAX_LIMIT} at most. When the result has \`next_page\`, send the same call with \`page\` set to that value to get more. Each thread has its ID, the subject of its first message, the sender and date of its last message, a snippet, its number of messages, and whether any message is unread. When the owner sets this tool to ask, it returns a pending approval with a link instead of threads; get_approval returns the threads after the owner approves.`,
    input: Schema.Struct({
      account: Schema.String,
      // Both go into the request's address, so each has a length limit.
      query: Schema.String.check(Schema.isBetweenLength(1, MAX_QUERY)),
      limit: Schema.optionalKey(
        Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_LIMIT })),
      ),
      page: Schema.optionalKey(Schema.String.check(Schema.isBetweenLength(1, MAX_PAGE))),
    }),
    expects: {
      account: "a string",
      query: `a string of 1 to ${MAX_QUERY} characters`,
      limit: `a whole number from 1 to ${MAX_LIMIT}`,
      page: "the next_page value of an earlier result",
    },
    view: {
      action: "search the mail",
      joiner: "of",
      empty: "This call has no other values. The sentence above is the whole call.",
      // The page marks every value as the agent's text, so each one is a value of the call.
      values: (args) =>
        Effect.succeed([
          { name: "Query", text: args.query, from: "agent" },
          { name: "Limit", text: String(args.limit ?? DEFAULT_LIMIT), from: "agent" },
          ...(args.page === undefined
            ? []
            : [{ name: "Page", text: args.page, from: "agent" as const }]),
        ]),
    },
    run: (send, account, args) =>
      searchThreads(send, {
        query: args.query,
        limit: args.limit ?? DEFAULT_LIMIT,
        page: args.page,
      }).pipe(Effect.map((found) => ({ account: account.email, ...found }))),
  }),
  accountTool({
    name: "read_thread",
    annotations: { readOnlyHint: true },
    label: "Read thread",
    group: "Find and read",
    irreversible: false,
    permissionDescription:
      "Read every message of a thread in full, and see the names of its attachments.",
    description: `Returns the messages of one thread of one Google account, oldest first, as plain text. \`account\` is the address of an account that list_accounts returns. \`thread\` is a thread ID that search_threads returned for that account; an ID works only in the account that returned it. \`message_count\` is the number of messages in the thread. Each message has its ID, its position in the thread, \`from\`, \`to\`, \`cc\`, its date, its label IDs, its text, and its attachments. When a message has Reply-To, \`reply_to\` is that header, unfolded and shortened to ${MAX_REPLY_HEADER} characters; a reply goes there instead of to \`from\` when it is not empty. A reply to the account's own message goes to that message's To. \`bcc\` is present when the message has that header, which is normally mail that the account wrote. A message that is a draft has \`draft\`, its draft ID. HTML mail is converted to plain text, and a link keeps its address in parentheses. An attachment has an ID, a file name, a media type, and a size in bytes; the result holds no file. \`inline: true\` marks an image that stands inside the body; converted HTML says \`[image: name]\` where it stood. A very long field is shortened: a list of recipients ends with \`… and N more\`, and \`attachments_left_out\` counts the attachments that are not listed. A result has at most ${LIMIT.toLocaleString("en-US")} characters. When it has \`next_page\`, it stops before the end of the thread: send the same call with \`page\` set to that value to get the rest. A message with \`text_cut\` does not hold its whole text: \`end\` means that the next page continues it, \`start\` that it continues the page before, and \`both\` means both. Reading changes nothing in Gmail: unread mail stays unread. When the owner sets this tool to ask, it returns a pending approval with a link instead of messages; get_approval returns the messages after the owner approves.`,
    input: Schema.Struct({
      account: Schema.String,
      thread: ThreadId,
      page: Schema.optionalKey(
        Schema.String.check(
          Schema.isBetweenLength(1, 100),
          Schema.makeFilter((page) => placeOf(page) !== null),
        ),
      ),
    }),
    expects: {
      account: "a string",
      thread: "a thread ID that search_threads returned",
      page: "the next_page value of an earlier result",
    },
    view: {
      action: "read a thread",
      joiner: "in",
      empty: "This call has no other values. The sentence above is the whole call.",
      values: (args, send) =>
        Effect.gen(function* () {
          const summary = yield* threadSummary(send, args.thread);
          const values: ViewValue[] = [
            { name: "Subject", text: summary.subject, from: "gmail" },
            { name: "Messages", text: String(summary.messages.length), from: "gmail" },
            { name: "Last message from", text: summary.from, from: "gmail" },
            { name: "Last message date", text: viewDate(summary.date), from: "gmail" },
          ];
          if (args.page !== undefined) {
            const place = placeOf(args.page);
            const position = place ? summary.messages.indexOf(place.message) : -1;
            if (!place || position < 0) return yield* Effect.fail(new ViewUnavailable());
            values.push({
              name: "Starts at",
              from: "agent",
              text: `Message ${position + 1} of ${summary.messages.length}${place.offset ? `, after its first ${place.offset.toLocaleString("en-US")} characters` : ""}`,
            });
          }
          return values;
        }),
    },
    run: (send, account, args) =>
      readThread(send, { account: account.email, thread: args.thread, page: args.page }),
  }),
  accountTool({
    name: "change_labels",
    label: "Change labels",
    group: "Organize",
    // A label that a call removed can be added back, and an archived thread returns to the inbox.
    irreversible: false,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    permissionDescription:
      "Archive threads, mark them read or unread, and add or remove labels. It cannot move mail to the trash or to spam, or take it out.",
    description: `Adds and removes labels on threads of one Google account. \`account\` is the address of an account that list_accounts returns. \`threads\` is a list of 1 to ${MAX_ITEMS} thread IDs that search_threads returned for that account. \`add\` and \`remove\` are lists of label IDs that list_labels returned for that account, at most ${MAX_LABELS} each; the call needs at least one label, and no label in both lists. The change applies to every message of each thread. To archive a thread, remove \`INBOX\`. The tool cannot add \`INBOX\`, because that would also take mail out of the trash or spam. To mark it as read, remove \`UNREAD\`; to mark it as unread, add \`UNREAD\`. To star it, add \`STARRED\`. Of the system labels, the tool accepts only \`UNREAD\`, \`STARRED\`, \`IMPORTANT\`, and the five \`CATEGORY_\` labels, and \`INBOX\` in \`remove\`: it does not move mail to the trash or to spam or take it out, and it creates no label. The result's \`threads\` has one entry for each thread that changed: its ID and \`labels\`, the IDs of the labels that at least one of its messages has after the change. \`not_found\` lists the threads that the account does not have. \`unconfirmed\` lists the threads whose change Google did not confirm: send the call again with those threads, because repeating a change is safe. Each of the two is left out when it is empty. The call fails as a whole only when no thread is confirmed changed. When it fails with a message that Google did not confirm the request, a thread may have changed, and sending the same call again is safe. When the owner sets this tool to ask, it returns a pending approval with a link instead of a result; get_approval returns the result after the owner approves.`,
    input: Schema.Struct({
      account: Schema.String,
      threads: Schema.Array(ThreadId).check(
        Schema.isBetweenLength(1, MAX_ITEMS),
        Schema.isUnique(),
      ),
      add: Schema.optionalKey(
        LabelIds.check(Schema.makeFilter((ids) => !ids.some((id) => REFUSED_ADD.has(id)))),
      ),
      remove: Schema.optionalKey(LabelIds),
    }).check(
      Schema.makeFilter((args) => {
        const { add, remove } = labelChange(args);
        if (add.length + remove.length === 0)
          return { path: ["add"], issue: "At least one label is required" };
        if (remove.some((id) => add.includes(id)))
          return { path: ["remove"], issue: "A label cannot be added and removed" };
        return undefined;
      }),
    ),
    expects: {
      account: "a string",
      threads: `a list of 1 to ${MAX_ITEMS} different thread IDs that search_threads returned`,
      add: LABELS_EXPECT,
      remove: LABELS_EXPECT,
    },
    view: {
      action: "add or remove labels on threads",
      joiner: "in",
      empty: "This call has no other values. The sentence above is the whole call.",
      notes: (args) => labelChangeNotes(labelChange(args)),
      values: (args, send) => labelChangeValues(send, labelChange(args)),
    },
    run: (send, account, args) =>
      changeLabels(send, {
        account: account.email,
        ...labelChange(args),
      }),
  }),
  accountTool({
    name: "create_draft",
    label: "Create draft",
    group: "Draft",
    // The owner can delete a draft, and writing one sends nothing.
    irreversible: false,
    permissionDescription: "Write a draft, new or as a reply. Nothing is sent.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    description:
      "Creates a draft, new or as a reply, in one Google account. Nothing is sent. `account` is the address of an account that list_accounts returns. `to`, `cc`, and `bcc` are optional lists of mailboxes, each an address or Name <address>. A draft needs no recipients or subject. `subject` is optional for a new draft, at most 998 characters, with no control characters. `body` is required plain text and may be empty. A reply includes no quote of the answered message unless you write one in body. `reply_to` is a message ID from read_thread for this account. A reply takes its recipients from the message's Reply-To when it has one (the reply_to field of read_thread), else from its From, and its subject from the message with Re: added when needed. A reply to the account's own message goes to that message's To. `reply_all: true` also includes the other To and Cc addresses, without the account's own address or repeated addresses. When you give a non-empty to, cc, or bcc, the reply has exactly the recipients you give. Give to when you must be sure where a reply goes. `reply_all: true` requires reply_to and cannot be combined with given recipients; a non-empty subject cannot be combined with reply_to. The result has account, draft, message, and thread. draft is the ID that stays while the draft exists; message and thread are the IDs at creation and can change when it is edited. `duplicate` is an optional whole number from 2 to 100 for a deliberate copy.\n\nRepeating: a call with the same arguments as a call of the last 7 days is the same call. It never creates a second draft. It returns the first call's result with `repeat_of`, or its pending approval. So when you get no answer or an error that says to try again, call again with exactly the same arguments. Copy them; do not reword the text, because changed text is a new draft. When the answer says that the outcome is unknown, do not try another wording: ask the owner to look in Gmail. To create one more draft with the same content on purpose, add `duplicate: 2` (then 3).\n\nWith ask, a reply that cannot be built appears on the owner's page, not in the agent's answer. When the owner sets this tool to ask, it returns a pending approval with a link instead of a draft; get_approval returns the draft after the owner approves." +
      "\n\n" +
      attachmentsDescription,
    input: DraftInput,
    also: (args) => alsoOf(args.attachments),
    uploads: (args) => uploadsOf(args.attachments),
    defaults: { to: [], cc: [], bcc: [], subject: "", reply_all: false, attachments: [] },
    unknown: (email, until, args) => {
      const next = (args.duplicate ?? 1) + 1;
      return `The server does not know whether the draft was created in ${email}. Ask the owner to look in Drafts. Until ${isoSeconds(until)}, repeating this call does not create it again.${next <= 100 ? ` If the owner says that the draft is missing, call again with duplicate: ${next}${uploadsOf(args.attachments).length ? " and a new upload of each file" : ""}.` : ""}`;
    },
    expects: draftExpects,
    view: {
      action: "create a draft",
      joiner: "in",
      empty: "This call has no other values. The sentence above is the whole call.",
      values: (args, send, sources) =>
        Effect.gen(function* () {
          const boxes = draftRecipients(args);
          const plan = args.reply_to
            ? yield* replyPlan(send, {
                account: normalizeEmail(args.account)!,
                message: args.reply_to,
                all: args.reply_all ?? false,
                given: givenRecipients(boxes),
              })
            : undefined;
          const mail = draftMail(args, boxes, plan);
          return draftValues(
            args,
            mail,
            boxes,
            plan,
            yield* attachmentValues(args.attachments ?? [], sources),
          );
        }),
    },
    create: (send, account, args, confirm, sources) =>
      Effect.gen(function* () {
        const boxes = draftRecipients(args);
        const plan = args.reply_to
          ? yield* replyPlan(send, {
              account: account.email,
              message: args.reply_to,
              all: args.reply_all ?? false,
              given: givenRecipients(boxes),
            })
          : undefined;
        const stage = yield* composedDraft(
          send,
          draftMail(args, boxes, plan),
          args.attachments,
          sources,
          plan?.thread,
        );
        if (alsoOf(args.attachments).length) yield* confirm.check;
        return yield* creating(stage);
      }),
  }),
  accountTool({
    name: "trash_messages",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    label: "Move to trash",
    group: "Trash and delete",
    // restore_messages takes a message out of the trash, for the 30 days that Gmail keeps it.
    irreversible: false,
    permissionDescription:
      "Move messages to the trash. Gmail deletes a message for good after 30 days there.",
    description: `Moves messages of one Google account to the trash. \`account\` is the address of an account that list_accounts returns. \`messages\` is a list of 1 to ${MAX_ITEMS} different message IDs that read_thread returned for that account; an ID works only in the account that returned it. Only the named messages move: the other messages of their threads stay where they are. In the trash, a message loses the label INBOX and keeps its other labels. Gmail deletes a message for good after 30 days in the trash, and restore_messages takes it out before that. In the result, \`messages\` holds each message that moved, with its label IDs after the change. \`not_found\` lists the IDs that the account does not have. \`unconfirmed\` lists the IDs for which Google did not confirm the change: call again with those IDs. Each of the two is present only when it is not empty. When no message moved, the call returns an error. Calling again with the same IDs is safe: a message that is already in the trash stays there. When the owner sets this tool to ask, it returns a pending approval with a link instead; get_approval returns the result after the owner approves.`,
    input: MessagesInput,
    expects: messagesExpects,
    view: {
      action: "move messages to the trash",
      joiner: "in",
      empty: "This call has no other values. The sentence above is the whole call.",
      values: (args, send) => messageValues(send, args.messages),
    },
    run: (send, account, args) =>
      trashMessages(send, { account: account.email, messages: args.messages }),
  }),
  accountTool({
    name: "restore_messages",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    label: "Restore from trash",
    group: "Trash and delete",
    // trash_messages puts the message back in the trash.
    irreversible: false,
    permissionDescription: "Take messages out of the trash.",
    description: `Takes messages of one Google account out of the trash. \`account\` is the address of an account that list_accounts returns. \`messages\` is a list of 1 to ${MAX_ITEMS} different message IDs that read_thread returned for that account; an ID works only in the account that returned it. Only the named messages are restored. In the result, \`messages\` holds each restored message with its label IDs after the change. A restored message is not back in the inbox: Gmail removes the label INBOX when a message goes to the trash and does not add it back, while the message keeps its other labels, such as UNREAD, STARRED, and the owner's own labels. It stays out of the trash and out of the inbox. \`not_found\` lists the IDs that the account does not have, which includes messages that were deleted for good. \`unconfirmed\` lists the IDs for which Google did not confirm the change: call again with those IDs. Each of the two is present only when it is not empty. When no message was restored, the call returns an error. Calling again with the same IDs is safe. When the owner sets this tool to ask, it returns a pending approval with a link instead; get_approval returns the result after the owner approves.`,
    input: MessagesInput,
    expects: messagesExpects,
    view: {
      action: "take messages out of the trash",
      joiner: "in",
      empty: "This call has no other values. The sentence above is the whole call.",
      values: (args, send) => messageValues(send, args.messages),
    },
    run: (send, account, args) =>
      restoreMessages(send, { account: account.email, messages: args.messages }),
  }),
  accountTool({
    name: "delete_messages",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    label: "Delete permanently",
    group: "Trash and delete",
    // Gmail cannot bring a deleted message back.
    irreversible: true,
    permissionDescription: "Delete messages for good, without the trash. Nobody can recover them.",
    description: `Deletes messages of one Google account for good. Gmail cannot bring them back, and they do not go to the trash. Use trash_messages when the owner may want a message back. \`account\` is the address of an account that list_accounts returns. \`messages\` is a list of 1 to ${MAX_ITEMS} different message IDs that read_thread returned for that account; an ID works only in the account that returned it. Only the named messages are deleted: the other messages of their threads stay. In the result, \`messages\` holds the IDs that were deleted. \`not_found\` lists the IDs that the account does not have. \`unconfirmed\` lists the IDs for which Google did not confirm the delete: call again with those IDs. Each of the two is present only when it is not empty. When no message was deleted, the call returns an error. A deleted message counts as not found. So when an ID was unconfirmed, or a call failed, got no answer, or ended as unknown, and a later call reports that ID as not found, the message is gone. When the owner sets this tool to ask, it returns a pending approval with a link instead; get_approval returns the result after the owner approves.`,
    input: MessagesInput,
    expects: messagesExpects,
    view: {
      action: "delete messages permanently",
      joiner: "from",
      empty: "This call has no other values. The sentence above is the whole call.",
      notes: () => [
        {
          text: "These messages cannot be recovered. They do not go to the trash: Gmail deletes them at once and for good.",
          warning: true,
        },
      ],
      values: (args, send) => messageValues(send, args.messages),
    },
    run: (send, account, args) =>
      deleteMessages(send, { account: account.email, messages: args.messages }),
  }),
  accountTool({
    name: "get_attachment",
    label: "Download attachment",
    group: "Download attachments",
    irreversible: false,
    permissionDescription:
      "Download a file attached to a message of this account, or copy it into mail that this connection writes from any account.",
    annotations: { readOnlyHint: true },
    description:
      "Returns one attachment of a message of one Google account. `account` is the address of an account that list_accounts returns. `message` is a message ID and `attachment` an attachment ID that read_thread returned for that account; both work only in that account. The result has two parts. The first is JSON with the account, the message, the attachment, and the file's name, media type, and size in bytes. The second is the file. In Claude Code the file comes as an embedded resource of any type: Claude Code saves it to disk and gives its path. In other clients an image (PNG, JPEG, GIF, or WebP) comes as an image and a text file as text, and any other file, such as a PDF, returns attachment_not_readable: tell the owner that Claude Code can open it. An attachment larger than 12 MB returns attachment_too_large with its size. Downloading changes nothing in Gmail. When the owner sets this tool to ask, it returns a pending approval with a link instead of the file; get_approval returns the file after the owner approves, for one hour.",
    input: Schema.Struct({
      account: Schema.String,
      message: Schema.String.check(
        Schema.isBetweenLength(1, 64),
        Schema.isPattern(/^[A-Za-z0-9_-]+$/u),
      ),
      attachment: Schema.String.check(Schema.isMaxLength(64), Schema.isPattern(/^\d+(\.\d+)*$/u)),
    }),
    expects: {
      account: "a string",
      message: "a message ID that read_thread returned",
      attachment: "an attachment ID that read_thread returned",
    },
    view: {
      action: "download an attachment",
      joiner: "from",
      empty: "This call has no other values. The sentence above is the whole call.",
      values: (args, send) =>
        Effect.gen(function* () {
          const found = yield* findAttachment(send, args);
          return [
            { name: "File", text: found.filename || "(no name)", from: "gmail" as const },
            { name: "Type", text: found.type, from: "gmail" as const },
            {
              name: "Size",
              text: `${found.size.toLocaleString("en-US")} bytes`,
              from: "gmail" as const,
            },
            { name: "From", text: shorten(found.from, 500), from: "gmail" as const },
            { name: "Subject", text: shorten(found.subject, 500), from: "gmail" as const },
            { name: "Date", text: viewDate(found.date), from: "gmail" as const },
          ];
        }),
    },
    run: (send, account, args, takes) =>
      Effect.gen(function* () {
        const found = yield* findAttachment(send, args);
        if (found.size > MAX_ATTACHMENT_BYTES)
          return yield* Effect.fail(tooLarge(found, MAX_ATTACHMENT_BYTES));
        if (!takes(found.type)) return yield* Effect.fail(notReadable(found));
        const bytes = yield* partBytes(send, args.message, found.part);
        if (bytes.byteLength > MAX_ATTACHMENT_BYTES)
          return yield* Effect.fail(
            tooLarge({ ...found, size: bytes.byteLength }, MAX_ATTACHMENT_BYTES),
          );
        return new WithFile(
          {
            account: account.email,
            message: args.message,
            attachment: args.attachment,
            filename: found.filename,
            type: found.type,
            size: found.size,
          },
          { bytes, filename: found.filename, type: found.type, charset: found.charset },
        );
      }),
  }),
  accountTool({
    name: "send_message",
    label: "Send message",
    group: "Send",
    irreversible: true,
    permissionDescription:
      "Send a new message from this account. A sent message cannot be taken back.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    description: `Sends a new plain text message from one Google account. A sent message cannot be taken back. \`account\` is the address of an account that list_accounts returns. \`to\` is a required non-empty list of mailboxes, each an address or Name <address>; \`cc\` and \`bcc\` are optional lists. \`subject\` is required, 1 to 998 characters without control characters. \`body\` is required plain text and may be empty. \`duplicate\` is an optional whole number from 2 to 100 for a deliberate copy. The result has account, message, and thread, the IDs of the sent message and its thread.\n\n${repeatSend}${deliberateSend}\n\nWith ask, a send that cannot be built appears on the owner's page, not in your answer. When the owner sets this tool to ask, it returns a pending approval with a link instead of sending; get_approval returns the result after the owner approves.\n\n${attachmentsDescription}`,
    input: Schema.Struct({
      account: DraftInput.fields.account,
      to: Mailboxes.check(Schema.isMinLength(1)),
      cc: DraftInput.fields.cc,
      bcc: DraftInput.fields.bcc,
      subject: Subject.check(Schema.isMinLength(1)),
      body: DraftInput.fields.body,
      duplicate: DraftInput.fields.duplicate,
      attachments: DraftInput.fields.attachments,
    }),
    expects: {
      account: draftExpects.account,
      to: "a list of at least one mailbox, each an address or Name <address>",
      cc: "a list of mailboxes, each an address or Name <address>",
      bcc: "a list of mailboxes, each an address or Name <address>",
      subject: `a string of 1 to ${MAX_SUBJECT} characters without control characters`,
      body: draftExpects.body,
      duplicate: draftExpects.duplicate,
      attachments: attachmentsExpect,
    },
    also: (args) => alsoOf(args.attachments),
    uploads: (args) => uploadsOf(args.attachments),
    defaults: { cc: [], bcc: [], attachments: [] },
    unknown: unknownSend,
    view: {
      action: "send a message",
      notes: () => [{ text: "A sent message cannot be taken back.", warning: true }],
      joiner: "from",
      empty: "This call has no other values. The sentence above is the whole call.",
      values: (args, _send, sources) =>
        Effect.gen(function* () {
          const boxes = draftRecipients(args);
          return draftValues(
            args,
            draftMail(args, boxes),
            boxes,
            undefined,
            yield* attachmentValues(args.attachments ?? [], sources),
          );
        }),
    },
    create: (send, _account, args, confirm, sources) =>
      sendMail(send, confirm, draftMail(args, draftRecipients(args)), args.attachments, sources),
  }),
  accountTool({
    name: "send_reply",
    label: "Send reply",
    group: "Send",
    irreversible: true,
    permissionDescription:
      "Reply to a message in its thread: to its reply address or its sender, or to everyone on it. A sent reply cannot be taken back.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    description: `Sends a plain text reply in a message's thread. A sent reply cannot be taken back. \`account\` is the address of an account that list_accounts returns. \`message\` is a message ID from read_thread for this account, 1 to 64 letters, digits, hyphens, or underscores. The recipients and subject come from that message, as in create_draft with reply_to and no given recipients: Reply-To (the reply_to field of read_thread) or From, or To for the account's own message, and Re: when needed. \`reply_all: true\` adds the message's other To and Cc recipients, without the account's own address or repeated addresses; it defaults to false. \`body\` is required plain text and may be empty. The body holds no quote unless you write one. \`duplicate\` is an optional whole number from 2 to 100 for a deliberate copy. The result has account, message, and thread, the IDs of the sent message and its thread.\n\n${repeatSend}${deliberateSend}\n\nWith ask, a send that cannot be built appears on the owner's page, not in your answer. When the owner sets this tool to ask, it returns a pending approval with a link instead of sending; get_approval returns the result after the owner approves.\n\n${attachmentsDescription}`,
    input: Schema.Struct({
      account: DraftInput.fields.account,
      message: MessageId,
      body: DraftInput.fields.body,
      reply_all: DraftInput.fields.reply_all,
      duplicate: DraftInput.fields.duplicate,
      attachments: DraftInput.fields.attachments,
    }),
    expects: {
      account: draftExpects.account,
      message: "a message ID of 1 to 64 letters, digits, hyphens, or underscores from this account",
      body: draftExpects.body,
      reply_all: "a boolean",
      duplicate: draftExpects.duplicate,
      attachments: attachmentsExpect,
    },
    also: (args) => alsoOf(args.attachments),
    uploads: (args) => uploadsOf(args.attachments),
    defaults: { reply_all: false, attachments: [] },
    unknown: unknownSend,
    view: {
      action: "send a reply",
      notes: () => [{ text: "A sent message cannot be taken back.", warning: true }],
      joiner: "from",
      empty: "This call has no other values. The sentence above is the whole call.",
      values: (args, send, sources) =>
        Effect.gen(function* () {
          const plan = yield* sendReplyPlan(send, args);
          const boxes = draftRecipients({});
          return draftValues(
            args,
            draftMail(args, boxes, plan),
            boxes,
            plan,
            yield* attachmentValues(args.attachments ?? [], sources),
          );
        }),
    },
    create: (send, _account, args, confirm, sources) =>
      sendReplyPlan(send, args).pipe(
        Effect.flatMap((plan) =>
          sendMail(
            send,
            confirm,
            draftMail(args, draftRecipients({}), plan),
            args.attachments,
            sources,
            plan.thread,
          ),
        ),
      ),
  }),
  accountTool({
    name: "forward_message",
    label: "Forward message",
    group: "Send",
    irreversible: true,
    permissionDescription:
      "Forward a message, with its text and its attachments, to the addresses the agent gives. It cannot be taken back.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    description: `Forwards a message's original text and every attachment, including inline images, as plain text with files. A sent message cannot be taken back. \`account\` is the address of an account that list_accounts returns. \`message\` is a message ID from read_thread for this account, 1 to 64 letters, digits, hyphens, or underscores. \`to\` is a required non-empty list of mailboxes, each an address or Name <address>; \`cc\` and \`bcc\` are optional lists. \`body\` is an optional plain text note before the forwarded text, empty by default. The forward stays in the original's thread in this account and adds Fwd: to its subject when needed. The limit is ${MAX_FORWARD_BYTES.toLocaleString("en-US")} bytes of attachments and text, and ${MAX_FORWARD_FILES} attachments. The original's text must fit ${PAGE_BODY_BYTES.toLocaleString("en-US")} bytes of body, ${MAX_TEXT.toLocaleString("en-US")} characters, and ${MAX_BODY_PARTS} body parts that Gmail gives apart; if it cannot be forwarded whole, nothing is sent. Parts that are neither plain/HTML text nor attachments are omitted, such as a calendar invitation without a file name or attachment ID. It needs only forward_message's setting. \`duplicate\` is an optional whole number from 2 to 100 for a deliberate copy. The result has account, message, and thread, the IDs of the sent message and its thread.\n\n${repeatSend}${deliberateSend}\n\nWith ask, a send that cannot be built appears on the owner's page, not in your answer. When the owner sets this tool to ask, it returns a pending approval with a link instead of sending; get_approval returns the result after the owner approves.`,
    input: Schema.Struct({
      account: DraftInput.fields.account,
      message: MessageId,
      to: Mailboxes.check(Schema.isMinLength(1)),
      cc: DraftInput.fields.cc,
      bcc: DraftInput.fields.bcc,
      body: Schema.optionalKey(DraftInput.fields.body),
      duplicate: DraftInput.fields.duplicate,
    }),
    expects: {
      account: draftExpects.account,
      message: "a message ID of 1 to 64 letters, digits, hyphens, or underscores from this account",
      to: "a list of at least one mailbox, each an address or Name <address>",
      cc: "a list of mailboxes, each an address or Name <address>",
      bcc: "a list of mailboxes, each an address or Name <address>",
      body: draftExpects.body,
      duplicate: draftExpects.duplicate,
    },
    defaults: { cc: [], bcc: [], body: "" },
    unknown: unknownSend,
    view: {
      action: "forward a message",
      notes: () => [{ text: "A sent message cannot be taken back.", warning: true }],
      joiner: "from",
      empty: "This call has no other values. The sentence above is the whole call.",
      values: (args, send) =>
        Effect.gen(function* () {
          const plan = yield* forwardPlan(send, args.message);
          if (plan.files.length > MAX_FORWARD_FILES)
            return yield* Effect.fail(new ViewUnavailable());
          const bytes =
            new TextEncoder().encode(forwardBody(plan.quoted, args.body)).byteLength +
            plan.files.reduce((n, f) => n + f.size, 0);
          if (bytes > MAX_FORWARD_BYTES)
            return yield* Effect.fail(messageTooLarge({ bytes, limit: MAX_FORWARD_BYTES }));
          const mail = draftMail({ body: "", subject: plan.subject }, draftRecipients(args));
          const recipients = draftValues({ body: "" }, mail, draftRecipients(args)).filter(
            (v) => v.name !== "Body",
          );
          return [
            { name: "Forwards a message from", text: plan.original.from, from: "gmail" as const },
            { name: "Its subject", text: plan.original.subject, from: "gmail" as const },
            { name: "Its date", text: viewDate(plan.original.date), from: "gmail" as const },
            ...recipients.map((v) => (v.name === "Subject" ? { ...v, from: "gmail" as const } : v)),
            ...fileValues(plan.files),
            ...(plan.omitted
              ? [
                  {
                    name: "Not forwarded",
                    text:
                      plan.omitted === 1
                        ? "1 part that is neither text nor a file, such as a calendar invitation"
                        : `${plan.omitted} parts that are neither text nor files, such as a calendar invitation`,
                    from: "gmail" as const,
                  },
                ]
              : []),
            ...duplicateValue(args.duplicate),
            ...(args.body ? [{ name: "Note", text: args.body, from: "agent" as const }] : []),
            { name: "Forwarded text", text: plan.quoted, from: "gmail" as const },
          ];
        }),
    },
    create: (send, _account, args, confirm) =>
      Effect.gen(function* () {
        const plan = yield* forwardPlan(send, args.message);
        const body = forwardBody(plan.quoted, args.body);
        const files = yield* forwardFiles(
          send,
          args.message,
          plan,
          new TextEncoder().encode(body).byteLength,
        );
        const message = mixedMessage(
          draftMail({ body, subject: plan.subject }, draftRecipients(args)),
          files,
        );
        return yield* sendStaged(confirm, uploadDraft(send, { message, thread: plan.thread }));
      }),
  }),
  accountTool({
    name: "send_draft",
    label: "Send draft",
    group: "Send",
    irreversible: true,
    permissionDescription:
      "Send a draft that exists in this account, as it is in Gmail at that moment. It cannot be taken back.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    description: `Sends an existing draft as it is in Gmail at that moment, including changes made there. With ask, a draft that the page cannot show whole cannot be approved: more than ${MAX_DRAFT_FILES} attachments, text that cannot be shown whole (${PAGE_BODY_BYTES.toLocaleString("en-US")} bytes of body, ${MAX_TEXT.toLocaleString("en-US")} characters, or ${MAX_BODY_PARTS} body parts that Gmail gives apart, or HTML that could not be converted), more than ${MAX_DRAFT_HEADERS.toLocaleString("en-US")} characters in its From, To, Cc, Bcc, and Subject, a repeated From, To, Cc, Bcc, Subject or Reply-To header, or a part that is neither text nor a file. A sent message cannot be taken back, and the draft is gone from Drafts afterwards. \`account\` is the address of an account that list_accounts returns. \`draft\` is a draft ID from create_draft or read_thread for this account, 1 to 64 letters, digits, hyphens, or underscores. The result has account, message, and thread, the IDs of the sent message and its thread.\n\n${repeatSend}\n\nWith ask, a send that cannot be built appears on the owner's page, not in your answer. When the owner sets this tool to ask, it returns a pending approval with a link instead of sending; get_approval returns the result after the owner approves.`,
    input: Schema.Struct({ account: DraftInput.fields.account, draft: MessageId }),
    expects: {
      account: draftExpects.account,
      draft: "a draft ID of 1 to 64 letters, digits, hyphens, or underscores from this account",
    },
    defaults: {},
    unknown: (email, until, args) =>
      `The server does not know whether draft "${args.draft}" went out from ${email}. Ask the owner to look in Sent. If the draft is still in Drafts, the owner can send it from Gmail. Until ${isoSeconds(until)}, repeating this call does not send it again.`,
    view: {
      action: "send a draft",
      joiner: "from",
      empty: "This call has no other values. The sentence above is the whole call.",
      notes: () => [{ text: draftNote, warning: true }],
      asItIs: true,
      values: (args, send) =>
        Effect.gen(function* () {
          const raw = yield* readDraft(send, args.draft);
          const names = ["From", "To", "Cc", "Bcc", "Subject", "Reply-To"];
          const headers = raw.payload.headers ?? [];
          if (
            names.some(
              (name) =>
                headers.filter((field) => field.name.toLowerCase() === name.toLowerCase()).length >
                1,
            )
          )
            return yield* Effect.fail(new ViewUnavailable());
          const fields = names.map((name) => ({
            name,
            text: header(raw.payload.headers, name),
          }));
          const files = attachmentParts(raw);
          if (
            fields
              .filter((field) => field.name !== "Reply-To")
              .reduce((n, f) => n + f.text.length, 0) > MAX_DRAFT_HEADERS ||
            files.length > MAX_DRAFT_FILES ||
            otherParts(raw).length > 0
          )
            return yield* Effect.fail(new ViewUnavailable());
          const parsed = yield* Effect.try({
            try: () => readMessage(raw),
            catch: () => new ToolFailure({ code: "google_unavailable" }),
          });
          const body = yield* textOf(send, parsed, new BodyBudget());
          if (!body.whole) return yield* Effect.fail(new ViewUnavailable());
          return [
            ...fields
              .filter((f) => f.text)
              .map((f) => ({
                ...f,
                text: ["To", "Cc", "Bcc"].includes(f.name) ? addresses(f.text).join(", ") : f.text,
                from: "draft" as const,
              })),
            ...fileValues(
              files.map((part) => ({
                filename: part.filename,
                type: part.mimeType,
                size: part.body.size,
              })),
            ).map((value) => ({ ...value, from: "draft" as const })),
            { name: "Body", text: body.text, from: "draft" as const },
          ];
        }),
    },
    create: (_send, _account, args, confirm) => sendExisting(confirm, args.draft),
  }),
  {
    kind: "plain",
    name: "get_approval",
    label: "Get approval result",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: { approval: { type: "string" } },
      required: ["approval"],
    },
    description:
      "Returns the state of a call that waits for the owner's approval, and the call's result once the owner approved it. `approval` is the approval ID from the pending answer. Call it after the owner tells you that they decided. It answers at once and never waits for the owner. When the approved call returns a file, the answer has a second part with the file, in the form that get_attachment describes. The status running can also mean that the owner approved and the file is not ready yet. A client that cannot read the file gets attachment_not_readable, and the file stays for the rest of its hour.",
    run: (ctx, args) => getApproval(ctx, args),
  },
  {
    kind: "plain",
    name: "create_upload_link",
    label: "Create upload link",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    description:
      "Gives a link that takes one local file, so that create_draft, send_message, or send_reply can attach it to mail. It needs a client that can read the owner's local files and send an HTTP request, such as Claude Code. It takes no input and returns `url` and `expires_at`. Send the file with one PUT request to `url` followed by the file's name, with the file's bytes as the body and its media type in the Content-Type header. With curl: `curl -sS -T <path> -H 'Content-Type: <media type>' '<url>'`. `url` ends with a slash, so curl adds the file's name itself. The answer to that request is JSON with `upload`, the ID of the stored file, and the name, type, and size that the server stored; check them against the file. Only that answer gives the ID. Then name the file as `{ \"upload\": \"<upload>\" }` in `attachments`. A link takes one file of at most 25 MB, once. The link, and a file that no call has used, end at `expires_at`. One upload attaches to one message; for another message, ask for another link. Never put a file's content into a tool argument. If the answer is a sign-in page and not JSON, the owner has not opened `/uploads/*` in Cloudflare Access yet; tell the owner. It returns tool_not_allowed when the owner has not allowed any tool that attaches files.",
    run: (ctx) =>
      Effect.gen(function* () {
        const listed = yield* readListedTools(
          ctx.db,
          ctx.owner,
          ctx.connection.connectionId,
          ctx.now(),
        );
        if (!listed.tools.some((name) => attachingTools().includes(name as AccountTool)))
          return yield* Effect.fail(
            new ToolFailure({
              code: "tool_not_allowed",
              said: `The owner has not allowed create_draft, send_message, or send_reply on any account for this connection, so it cannot attach a file. The owner can change this at ${ctx.origin}/connections/${ctx.connection.connectionId}.`,
            }),
          );
        const created = yield* createLink(ctx);
        if (!created) return yield* Effect.fail(new ToolFailure({ code: "server_unavailable" }));
        return {
          url: `${ctx.origin}${UPLOAD_PATH}${created.link}/`,
          expires_at: isoSeconds(created.expiresAt),
        };
      }),
  },
];
export const parseAccountTool = (raw: unknown): AccountTool | null => {
  const tool = TOOLS.find((t) => t.kind === "account" && t.name === raw);
  return tool?.kind === "account" ? tool.name : null;
};

export type ListedTools = {
  readonly active: boolean;
  readonly tools: ReadonlyArray<Tool>;
};
export const listedTools = (ctx: CallContext): Effect.Effect<ListedTools, Unavailable> =>
  readListedTools(ctx.db, ctx.owner, ctx.connection.connectionId, ctx.now()).pipe(
    Effect.map(({ active, tools }) => ({
      active,
      tools: TOOLS.filter((tool) => tool.kind === "plain" || tools.includes(tool.name)),
    })),
  );

import type { Tool as McpTool } from "@modelcontextprotocol/server";
import { viewDate, type ViewNote, type ViewValue } from "../approvals/model";
import { getApproval } from "../approvals/result";
import { Data, Effect, Result, Schema, SchemaIssue } from "effect";
import type { Unavailable } from "../db";
import { accountMessage } from "../accounts/model";
import { listVisibleAccounts } from "../accounts/store";
import { findAttachment, partBytes } from "../google/attachment";
import { shorten } from "../google/bounds";
import { MAX_ATTACHMENT_BYTES, WithFile, type Takes } from "./file";
import { LIMIT, placeOf, readThread } from "../google/thread";
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
import { readListedTools } from "../permissions/store";
import type { CallContext } from "./call";
import { creating, notReadable, tooLarge, type ToolFailure } from "./failures";
import type { Group } from "./groups";
import type { Created } from "../once/store";
import { createDraft } from "../google/draft";
import {
  MAX_SUBJECT,
  mailboxText,
  messageText,
  parseMailbox,
  rawMessage,
  type Mailbox,
  type Outgoing,
} from "../google/mail";
import { replyPlan, type ReplyPlan } from "../google/reply";
import { normalizeEmail } from "../owner/owner";
import { isoSeconds } from "../approvals/model";
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
/** What tools/list tells a client about a tool. A tool that changes mail says so. */
export type ToolAnnotations =
  | { readOnlyHint: true }
  | { readOnlyHint: false; destructiveHint: boolean; idempotentHint: boolean };
export type Tool =
  | {
      kind: "plain";
      name: "list_accounts" | "get_approval";
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
      permissionDescription: string;
      description: string;
      annotations: ToolAnnotations;
      input: Schema.Codec<DecodedArgs, unknown>;
      /** What each field must be, for the message of invalid_arguments. */
      expects: Readonly<Record<string, string>>;
      view: {
        action: string;
        joiner: string;
        empty: string;
        /** Sentences that the page says about this call, from its arguments alone. */
        notes?: (args: DecodedArgs) => ReadonlyArray<ViewNote>;
        values: (
          args: DecodedArgs,
          send: Send,
        ) => Effect.Effect<ReadonlyArray<ViewValue>, ViewUnavailable | ToolFailure>;
      };
    } & AccountExecution<DecodedArgs>);
type AccountDefinition<A extends DecodedArgs> = {
  name: string;
  label: string;
  group: Group;
  permissionDescription: string;
  description: string;
  annotations: ToolAnnotations;
  input: Schema.Codec<A, unknown>;
  expects: Readonly<Record<keyof A & string, string>>;
  view: {
    action: string;
    joiner: string;
    empty: string;
    /** Sentences that the page says about this call, from its arguments alone. */
    notes?: (args: A) => ReadonlyArray<ViewNote>;
    values: (
      args: A,
      send: Send,
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
const DraftInput = Schema.Struct({
  account: Schema.String,
  to: Schema.optionalKey(Mailboxes),
  cc: Schema.optionalKey(Mailboxes),
  bcc: Schema.optionalKey(Mailboxes),
  subject: Schema.optionalKey(
    Schema.String.check(
      Schema.isMaxLength(MAX_SUBJECT),
      // oxlint-disable-next-line no-control-regex -- Input subjects cannot contain header controls.
      Schema.isPattern(/^[^\u0000-\u001f\u007f]*$/),
    ),
  ),
  body: Schema.String,
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
const draftRecipients = (args: DraftArgs) => ({
  to: (args.to ?? []).map((text) => parseMailbox(text)!),
  cc: (args.cc ?? []).map((text) => parseMailbox(text)!),
  bcc: (args.bcc ?? []).map((text) => parseMailbox(text)!),
});
const givenRecipients = (boxes: { to: Mailbox[]; cc: Mailbox[]; bcc: Mailbox[] }) =>
  boxes.to.length || boxes.cc.length || boxes.bcc.length ? boxes : null;
const draftMail = (
  args: DraftArgs,
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

export const TOOLS: ReadonlyArray<Tool> = [
  {
    kind: "plain",
    name: "list_accounts",
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
    permissionDescription:
      "Read every message of a thread in full, and see the names of its attachments.",
    description: `Returns the messages of one thread of one Google account, oldest first, as plain text. \`account\` is the address of an account that list_accounts returns. \`thread\` is a thread ID that search_threads returned for that account; an ID works only in the account that returned it. \`message_count\` is the number of messages in the thread. Each message has its ID, its position in the thread, \`from\`, \`to\`, \`cc\`, its date, its label IDs, its text, and its attachments. \`bcc\` is present when the message has that header, which is normally mail that the account wrote. A message that is a draft has \`draft\`, its draft ID. HTML mail is converted to plain text, and a link keeps its address in parentheses. An attachment has an ID, a file name, a media type, and a size in bytes; the result holds no file. \`inline: true\` marks an image that stands inside the body; converted HTML says \`[image: name]\` where it stood. A very long field is shortened: a list of recipients ends with \`… and N more\`, and \`attachments_left_out\` counts the attachments that are not listed. A result has at most ${LIMIT.toLocaleString("en-US")} characters. When it has \`next_page\`, it stops before the end of the thread: send the same call with \`page\` set to that value to get the rest. A message with \`text_cut\` does not hold its whole text: \`end\` means that the next page continues it, \`start\` that it continues the page before, and \`both\` means both. Reading changes nothing in Gmail: unread mail stays unread. When the owner sets this tool to ask, it returns a pending approval with a link instead of messages; get_approval returns the messages after the owner approves.`,
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
    name: "get_attachment",
    label: "Download attachment",
    group: "Download attachments",
    permissionDescription: "Download a file attached to a message of this account.",
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
    name: "change_labels",
    label: "Change labels",
    group: "Organize",
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
    permissionDescription: "Write a draft, new or as a reply. Nothing is sent.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    description:
      "Creates a draft, new or as a reply, in one Google account. Nothing is sent. `account` is the address of an account that list_accounts returns. `to`, `cc`, and `bcc` are optional lists of mailboxes, each an address or Name <address>. A draft needs no recipients or subject. `subject` is optional for a new draft, at most 998 characters, with no control characters. `body` is required plain text and may be empty. A reply includes no quote of the answered message unless you write one in body. `reply_to` is a message ID from read_thread for this account. A reply takes its recipients from the message's Reply-To when it has one, else from its From, and its subject from the message with Re: added when needed. A reply to the account's own message goes to that message's To. `reply_all: true` also includes the other To and Cc addresses, without the account's own address or repeated addresses. When you give a non-empty to, cc, or bcc, the reply has exactly the recipients you give. Give to when you must be sure where a reply goes. `reply_all: true` requires reply_to and cannot be combined with given recipients; a non-empty subject cannot be combined with reply_to. The result has account, draft, message, and thread. draft is the ID that stays while the draft exists; message and thread are the IDs at creation and can change when it is edited. `duplicate` is an optional whole number from 2 to 100 for a deliberate copy.\n\nRepeating: a call with the same arguments as a call of the last 7 days is the same call. It never creates a second draft. It returns the first call's result with `repeat_of`, or its pending approval. So when you get no answer or an error that says to try again, call again with exactly the same arguments. Copy them; do not reword the text, because changed text is a new draft. When the answer says that the outcome is unknown, do not try another wording: ask the owner to look in Gmail. To create one more draft with the same content on purpose, add `duplicate: 2` (then 3).\n\nWith ask, a reply that cannot be built appears on the owner's page, not in the agent's answer. When the owner sets this tool to ask, it returns a pending approval with a link instead of a draft; get_approval returns the draft after the owner approves.",
    input: DraftInput,
    defaults: { to: [], cc: [], bcc: [], subject: "", reply_all: false },
    unknown: (email, until, args) => {
      const next = (args.duplicate ?? 1) + 1;
      return `The server does not know whether the draft was created in ${email}. Ask the owner to look in Drafts. Until ${isoSeconds(until)}, repeating this call does not create it again.${next <= 100 ? ` If the owner says that the draft is missing, call again with duplicate: ${next}.` : ""}`;
    },
    expects: {
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
    },
    view: {
      action: "create a draft",
      joiner: "in",
      empty: "This call has no other values. The sentence above is the whole call.",
      values: (args, send) =>
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
          const values: ViewValue[] = [];
          if (plan) {
            const date = new Intl.DateTimeFormat("en-US", {
              month: "short",
              day: "numeric",
              year: "numeric",
              timeZone: "UTC",
            }).format(plan.answered.date);
            const time = new Intl.DateTimeFormat("en-GB", {
              hour: "2-digit",
              minute: "2-digit",
              timeZone: "UTC",
            }).format(plan.answered.date);
            values.push(
              {
                name: "Answers a message from",
                text: shorten(plan.answered.from, 1000),
                from: "gmail",
              },
              { name: "Its subject", text: shorten(plan.answered.subject, 1000), from: "gmail" },
              { name: "Its date", text: `${date} at ${time} UTC`, from: "gmail" },
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
          if (args.duplicate !== undefined)
            values.push({
              name: "Duplicate",
              text: `${args.duplicate} (a deliberate copy of an earlier call)`,
              from: "agent",
            });
          values.push({ name: "Body", text: args.body, from: "agent" });
          return values;
        }),
    },
    create: (send, account, args) =>
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
        return yield* creating(
          createDraft(send, {
            raw: rawMessage(messageText(draftMail(args, boxes, plan))),
            ...(plan ? { thread: plan.thread } : {}),
          }),
        );
      }),
  }),
  {
    kind: "plain",
    name: "get_approval",
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

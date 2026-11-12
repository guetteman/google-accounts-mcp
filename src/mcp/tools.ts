import type { Tool as McpTool } from "@modelcontextprotocol/server";
import { getApproval } from "../approvals/result";
import { Data, Effect, Result, Schema } from "effect";
import type { Unavailable } from "../db";
import { accountMessage } from "../accounts/model";
import { listVisibleAccounts } from "../accounts/store";
import { listLabels, searchThreads } from "../google/gmail";
import { readListedTools } from "../permissions/store";
import type { CallContext } from "./call";
import type { ToolFailure } from "./failures";
import type { Group } from "./groups";
export class ViewUnavailable extends Data.TaggedError("ViewUnavailable") {}
/** What every tool with a setting takes. A tool reads its own fields through its typed definition. */
export type DecodedArgs = { readonly account: string };
/** A name that the tool list accepted. The list below is the only list of tool names. */
export type AccountTool = string & { readonly __accountTool: unique symbol };
/** Tools supply a request, never receive a credential or token store. */
export type Send = (
  build: (accessToken: string, signal: AbortSignal) => Request,
) => Effect.Effect<Response, ToolFailure>;
export type Tool =
  | {
      kind: "plain";
      name: "list_accounts" | "get_approval";
      inputSchema?: McpTool["inputSchema"];
      description: string;
      run: (
        ctx: CallContext,
        args: Record<string, unknown> | undefined,
      ) => Effect.Effect<unknown, Unavailable | ToolFailure>;
    }
  | {
      kind: "account";
      name: AccountTool;
      label: string;
      group: Group;
      permissionDescription: string;
      description: string;
      input: Schema.Codec<DecodedArgs, unknown>;
      /** What each field must be, for the message of invalid_arguments. */
      expects: Readonly<Record<string, string>>;
      view: {
        action: string;
        joiner: string;
        empty: string;
        values: (
          args: DecodedArgs,
        ) => Effect.Effect<ReadonlyArray<{ name: string; text: string }>, ViewUnavailable>;
      };
      run: (
        send: Send,
        account: { email: string },
        args: DecodedArgs,
      ) => Effect.Effect<unknown, ToolFailure>;
    };
type AccountDefinition<A extends DecodedArgs> = {
  name: string;
  label: string;
  group: Group;
  permissionDescription: string;
  description: string;
  input: Schema.Codec<A, unknown>;
  expects: Readonly<Record<keyof A & string, string>>;
  view: {
    action: string;
    joiner: string;
    empty: string;
    values: (
      args: A,
    ) => Effect.Effect<ReadonlyArray<{ name: string; text: string }>, ViewUnavailable>;
  };
  run: (send: Send, account: { email: string }, args: A) => Effect.Effect<unknown, ToolFailure>;
};
// The runner passes a tool only the arguments that the tool's own input decoded.
const accountTool = <A extends DecodedArgs>(definition: AccountDefinition<A>) =>
  ({ kind: "account", ...definition }) as unknown as Extract<Tool, { kind: "account" }>;
/** The field that fails a tool's input, or null when the arguments are not an object. */
export const decodeArgs = (
  tool: Extract<Tool, { kind: "account" }>,
  args: unknown,
): { ok: true; value: DecodedArgs } | { ok: false; field: string | null } => {
  const result = Schema.decodeUnknownResult(tool.input)(args);
  if (Result.isSuccess(result)) return { ok: true, value: result.success };
  let issue: unknown = result.failure.issue;
  while (typeof issue === "object" && issue !== null) {
    if ("path" in issue && Array.isArray(issue.path) && typeof issue.path[0] === "string")
      return { ok: false, field: issue.path[0] };
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

export const TOOLS: ReadonlyArray<Tool> = [
  {
    kind: "plain",
    name: "list_accounts",
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
          { name: "Query", text: args.query },
          { name: "Limit", text: String(args.limit ?? DEFAULT_LIMIT) },
          ...(args.page === undefined ? [] : [{ name: "Page", text: args.page }]),
        ]),
    },
    run: (send, account, args) =>
      searchThreads(send, {
        query: args.query,
        limit: args.limit ?? DEFAULT_LIMIT,
        page: args.page,
      }).pipe(Effect.map((found) => ({ account: account.email, ...found }))),
  }),
  {
    kind: "plain",
    name: "get_approval",
    inputSchema: {
      type: "object",
      properties: { approval: { type: "string" } },
      required: ["approval"],
    },
    description:
      "Returns the state of a call that waits for the owner's approval, and the call's result once the owner approved it. `approval` is the approval ID from the pending answer. Call it after the owner tells you that they decided. It answers at once and never waits for the owner.",
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

import type { Tool as McpTool } from "@modelcontextprotocol/server";
import { getApproval } from "../approvals/result";
import { Data, Effect, Schema } from "effect";
import type { Unavailable } from "../db";
import { accountMessage } from "../accounts/model";
import { listVisibleAccounts } from "../accounts/store";
import { listLabels } from "../google/gmail";
import type { CallContext, ToolFailure } from "./call";
export class ViewUnavailable extends Data.TaggedError("ViewUnavailable") {}
export type DecodedArgs = { readonly account: string };
export type AccountTool = "list_labels";
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
      permissionDescription: string;
      description: string;
      input: Schema.Struct<{ account: typeof Schema.String }>;
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
  {
    kind: "account",
    name: "list_labels",
    label: "List labels",
    permissionDescription: "See the names of this account's Gmail labels.",
    description:
      "Lists the Gmail labels of one Google account. `account` is the address of an account that list_accounts returns.",
    input: Schema.Struct({ account: Schema.String }),
    view: {
      action: "list the Gmail labels",
      joiner: "of",
      empty: "This call has no other values. The sentence above is the whole call.",
      values: () => Effect.succeed([]),
    },
    run: (send, account) =>
      listLabels(send).pipe(Effect.map((labels) => ({ account: account.email, labels }))),
  },
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

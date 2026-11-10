import { Effect, Schema } from "effect";
import type { Unavailable } from "../db";
import { accountMessage } from "../accounts/model";
import { listVisibleAccounts } from "../accounts/store";
import { listLabels } from "../google/gmail";
import type { CallContext, ToolFailure } from "./call";
export type AccountTool = "list_labels";
/** Tools supply a request, never receive a credential or token store. */
export type Send = (
  build: (accessToken: string, signal: AbortSignal) => Request,
) => Effect.Effect<Response, ToolFailure>;
export type Tool =
  | {
      kind: "plain";
      name: "list_accounts";
      description: string;
      run: (ctx: CallContext) => Effect.Effect<unknown, Unavailable>;
    }
  | {
      kind: "account";
      name: AccountTool;
      label: string;
      permissionDescription: string;
      description: string;
      input: Schema.Struct<{ account: typeof Schema.String }>;
      run: (send: Send, account: { email: string }) => Effect.Effect<unknown, ToolFailure>;
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
    run: (send, account) =>
      listLabels(send).pipe(Effect.map((labels) => ({ account: account.email, labels }))),
  },
];
export const parseAccountTool = (raw: unknown): AccountTool | null => {
  const tool = TOOLS.find((t) => t.kind === "account" && t.name === raw);
  return tool?.kind === "account" ? tool.name : null;
};

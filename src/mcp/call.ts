import { Data, Effect, Result, Schema } from "effect";
import {
  ProtocolError,
  ProtocolErrorCode,
  type CallToolResult,
} from "@modelcontextprotocol/server";
import type { Config } from "../config";
import type { ActiveConnection } from "../connections/model";
import { normalizeEmail, type Owner } from "../owner/owner";
import { accountMessage, type AccountStatus, type Credential } from "../accounts/model";
import { allowedAccountStatement, decodeAllowedAccount } from "../accounts/store";
import { withGoogle, type TokenError } from "../accounts/tokens";
import {
  closeCall,
  decodeCallId,
  recordStatement,
  type CallId,
  type Outcome,
} from "../calls/store";
import { TOOLS, type Send, type Tool } from "./tools";
export interface CallContext {
  db: D1Database;
  config: Config;
  owner: Owner;
  connection: ActiveConnection;
  origin: string;
  now: () => number;
}
type Allowed = { credential: Credential; status: AccountStatus };
const failures = {
  invalid_arguments: { outcome: "refused", message: () => "The account field must be a string." },
  account_not_available: {
    outcome: "refused",
    message: (input: string) =>
      `No account "${input}" is available to this connection. Call list_accounts to see the accounts you can use.`,
  },
  account_needs_reconnect: {
    outcome: "failed",
    message: (_: string, email: string, origin: string) =>
      accountMessage("needs_reconnect", email, origin),
  },
  account_blocked_by_admin: {
    outcome: "failed",
    message: (_: string, email: string, origin: string) =>
      accountMessage("blocked_by_admin", email, origin),
  },
  account_missing_access: {
    outcome: "failed",
    message: (_: string, email: string, origin: string) =>
      accountMessage("missing_access", email, origin),
  },
  account_unreadable: {
    outcome: "failed",
    message: (_: string, email: string, origin: string) =>
      accountMessage("unreadable", email, origin),
  },
  google_unavailable: {
    outcome: "failed",
    message: (_: string, email: string) =>
      `Google could not complete the request for ${email}. Try again later.`,
  },
  server_unavailable: {
    outcome: "failed",
    message: () => "The server could not complete the call. Try again later.",
  },
} satisfies Record<
  string,
  { outcome: Outcome; message: (input: string, email: string, origin: string) => string }
>;
export class ToolFailure extends Data.TaggedError("ToolFailure")<{
  code: keyof typeof failures;
  unknown?: boolean;
}> {}
const tokenFailure = (error: TokenError): ToolFailure => {
  switch (error._tag) {
    case "NeedsReconnect":
      return new ToolFailure({ code: "account_needs_reconnect" });
    case "BlockedByAdmin":
      return new ToolFailure({ code: "account_blocked_by_admin" });
    case "AccountGone":
      return new ToolFailure({ code: "account_not_available" });
    case "GoogleUnavailable":
      return new ToolFailure({ code: "google_unavailable" });
    case "RequestLost":
      return new ToolFailure({ code: "google_unavailable", unknown: true });
    case "Unavailable":
      return new ToolFailure({ code: "server_unavailable" });
  }
};
async function executeAccount(
  ctx: CallContext,
  tool: Extract<Tool, { kind: "account" }>,
  allowed: Allowed,
) {
  if (allowed.status.kind === "missing_access" || allowed.status.kind === "unreadable")
    throw new ToolFailure({ code: `account_${allowed.status.kind}` });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  const send: Send = (build) =>
    withGoogle(ctx, allowed.credential, (token) => {
      // withGoogle can retry after a 401. Each attempt owns a fresh request and deadline.
      clearTimeout(timer);
      controller = new AbortController();
      timer = setTimeout(() => {
        controller?.abort();
      }, 10000);
      return build(token, controller.signal);
    }).pipe(Effect.mapError(tokenFailure));
  try {
    const result = await Effect.runPromise(
      Effect.result(tool.run(send, { email: allowed.credential.email })),
    );
    if (Result.isFailure(result)) throw result.failure;
    return result.success;
  } finally {
    clearTimeout(timer);
  }
}
export async function runCall(
  ctx: CallContext,
  name: string,
  args: Record<string, unknown> | undefined,
): Promise<CallToolResult> {
  let id: CallId | null = null;
  let email = "";
  const input = typeof args?.account === "string" ? args.account : "";
  let unknownTool = false;
  let result: CallToolResult;
  let outcome: Outcome | null = "success";
  try {
    const tool = TOOLS.find((t) => t.name === name);
    const account = tool?.kind === "account" ? normalizeEmail(input) : null;
    const statements = [recordStatement(ctx, tool?.name ?? null, account)];
    if (tool?.kind === "account" && account)
      statements.push(allowedAccountStatement(ctx, tool.name, account));
    const batch = await ctx.db.batch(statements);
    id = decodeCallId(batch[0]!);
    if (!id) throw new ToolFailure({ code: "server_unavailable" });
    if (!tool) {
      unknownTool = true;
      outcome = "refused";
      result = { content: [] };
    } else {
      let value: unknown;
      if (tool.kind === "plain") {
        const plain = await Effect.runPromise(Effect.result(tool.run(ctx)));
        if (Result.isFailure(plain)) throw new ToolFailure({ code: "server_unavailable" });
        value = plain.success;
      } else {
        if (Schema.decodeUnknownOption(tool.input)(args)._tag === "None")
          throw new ToolFailure({ code: "invalid_arguments" });
        const row = batch[1]?.results[0];
        if (!row) throw new ToolFailure({ code: "account_not_available" });
        const allowed: Allowed = await decodeAllowedAccount(row, ctx.config.tokenKey);
        email = allowed.credential.email;
        value = await executeAccount(ctx, tool, allowed);
      }
      result = { content: [{ type: "text", text: JSON.stringify(value) }] };
    }
  } catch (error) {
    const failure =
      error instanceof ToolFailure ? error : new ToolFailure({ code: "server_unavailable" });
    const entry = failures[failure.code];
    outcome = failure.unknown ? null : entry.outcome;
    if (entry.outcome === "failed") console.error("Tool call failed", failure.code);
    result = {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            code: failure.code,
            message: entry.message(input, email, ctx.origin),
          }),
        },
      ],
    };
  }
  if (id && outcome) {
    try {
      await Effect.runPromise(closeCall(ctx, id, outcome));
    } catch {
      console.error("Tool call failed", "server_unavailable");
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({
              code: "server_unavailable",
              message: failures.server_unavailable.message(),
            }),
          },
        ],
      };
    }
  }
  if (unknownTool)
    throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Tool ${name} not found`);
  return result;
}

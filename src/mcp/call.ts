import { createApproval } from "../approvals/store";
import { APPROVAL_LIFETIME, type ApprovalId } from "../approvals/model";
import { pendingAnswer } from "../approvals/result";
import { sealArguments } from "../approvals/text";
import { classify, failures, ToolFailure } from "./failures";
import { Effect, Result, Schema } from "effect";
import {
  ProtocolError,
  ProtocolErrorCode,
  type CallToolResult,
} from "@modelcontextprotocol/server";
import type { Config } from "../config";
import type { ActiveConnection } from "../connections/model";
import { normalizeEmail, type Owner } from "../owner/owner";
import type { AccountStatus, Credential } from "../accounts/model";
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
export const MAX_ARGUMENTS_BYTES = 256 * 1024;

export interface CallContext {
  db: D1Database;
  config: Config;
  owner: Owner;
  connection: ActiveConnection;
  origin: string;
  now: () => number;
}
type Allowed = { credential: Credential; status: AccountStatus };
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
export async function executeAccount(
  ctx: CallContext,
  tool: Extract<Tool, { kind: "account" }>,
  allowed: Allowed,
  args: import("./tools").DecodedArgs,
  deadline = Infinity,
  signal?: AbortSignal,
) {
  if (allowed.status.kind === "missing_access" || allowed.status.kind === "unreadable")
    throw new ToolFailure({ code: `account_${allowed.status.kind}` });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  const send: Send = (build) =>
    withGoogle(ctx, allowed.credential, (token) => {
      // withGoogle can retry after a 401. Each attempt owns a fresh request and deadline.
      if (ctx.now() >= deadline || signal?.aborted)
        throw new ToolFailure({ code: "google_unavailable", unknown: true });
      clearTimeout(timer);
      controller = new AbortController();
      timer = setTimeout(
        () => {
          controller?.abort();
        },
        Math.min(10000, deadline - ctx.now()),
      );
      return build(
        token,
        signal ? AbortSignal.any([controller.signal, signal]) : controller.signal,
      );
    }).pipe(Effect.mapError(tokenFailure));
  try {
    const result = await Effect.runPromise(
      Effect.result(tool.run(send, { email: allowed.credential.email }, args)),
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
  const at = ctx.now();
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
        const plain = await Effect.runPromise(Effect.result(tool.run(ctx, args)));
        if (Result.isFailure(plain)) throw plain.failure;
        value = plain.success;
      } else {
        const decoded = Schema.decodeUnknownOption(tool.input)(args);
        if (decoded._tag === "None") throw new ToolFailure({ code: "invalid_arguments" });
        const json = JSON.stringify(decoded.value);
        if (new TextEncoder().encode(json).byteLength > MAX_ARGUMENTS_BYTES)
          throw new ToolFailure({ code: "invalid_arguments", reason: "arguments_too_large" });
        const row = batch[1]?.results[0];
        if (!row) throw new ToolFailure({ code: "account_not_available" });
        const allowed: Allowed = await decodeAllowedAccount(row, ctx.config.tokenKey);
        email = allowed.credential.email;
        if ((row as { ask: unknown }).ask !== 0) {
          if (["needs_reconnect", "missing_access", "unreadable"].includes(allowed.status.kind))
            throw new ToolFailure({
              code: `account_${allowed.status.kind}` as
                | "account_needs_reconnect"
                | "account_missing_access"
                | "account_unreadable",
            });
          const approval = crypto.randomUUID() as ApprovalId;
          const argumentsSealed = await sealArguments(ctx.config.tokenKey, approval, decoded.value);
          // Once the batch starts, its lost response must never close the audit record.
          const created = await Effect.runPromise(
            Effect.result(
              createApproval(ctx, {
                id: approval,
                call: id,
                tool: tool.name,
                uses: [{ account: allowed.credential.id, tool: tool.name }],
                arguments: argumentsSealed,
                at,
              }),
            ),
          );
          if (Result.isFailure(created))
            throw new ToolFailure({ code: "server_unavailable", unknown: true });
          if (created.success !== "created") {
            throw new ToolFailure({
              code:
                created.success === "limit" ? "approval_limit_reached" : "account_not_available",
            });
          }
          outcome = null;
          value = pendingAnswer(ctx.origin, approval, at + APPROVAL_LIFETIME);
        } else value = await executeAccount(ctx, tool, allowed, decoded.value);
      }
      result = { content: [{ type: "text", text: JSON.stringify(value) }] };
    }
  } catch (error) {
    const classified = classify(
      error,
      { approved: false, aborted: false },
      { input, email, origin: ctx.origin },
    );
    outcome = classified.audit;
    if (classified.audit === "failed") console.error("Tool call failed", classified.error?.code);
    result = { isError: true, content: [{ type: "text", text: JSON.stringify(classified.error) }] };
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

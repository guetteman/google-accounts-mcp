import { createApproval } from "../approvals/store";
import { APPROVAL_LIFETIME, CALL_DEADLINE, isoSeconds, type ApprovalId } from "../approvals/model";
import { pendingAnswer } from "../approvals/result";
import { sealArguments } from "../approvals/text";
import { classify, failures, ToolFailure } from "./failures";
import { Effect, Result } from "effect";
import {
  ProtocolError,
  ProtocolErrorCode,
  type CallToolResult,
} from "@modelcontextprotocol/server";
import type { Config } from "../config";
import type { ActiveConnection } from "../connections/model";
import { normalizeEmail, type Owner } from "../owner/owner";
import type { AccountStatus, Credential } from "../accounts/model";
import {
  allowedAccountStatement,
  decodeAllowedAccount,
  seenAccountStatement,
} from "../accounts/store";
import { googleSession, type TokenError } from "../accounts/tokens";
import {
  closeCall,
  decodeCallId,
  recordStatement,
  type CallId,
  type Outcome,
} from "../calls/store";
import {
  decodeArgs,
  TOOLS,
  type DecodedArgs,
  type Send,
  type Sending,
  type Confirm,
  type Tool,
} from "./tools";
import { identityOf } from "../once/identity";
import { take, settle, release, WINDOW, type Repeat } from "../once/store";
export const MAX_ARGUMENTS_BYTES = 256 * 1024;
export const SEND_RESERVE = 5_000;
export { CALL_DEADLINE } from "../approvals/model";

export interface CallContext {
  db: D1Database;
  config: Config;
  owner: Owner;
  connection: ActiveConnection;
  origin: string;
  now: () => number;
  waitUntil: (work: Promise<unknown>) => void;
}
export type Executed = { kind: "ran"; value: unknown } | { kind: "repeat"; repeat: Repeat };
export const repeatAnswer = (
  repeat: Repeat,
  account: string,
  tool: Extract<Tool, { kind: "account" }>,
  args: DecodedArgs & { readonly duplicate?: number },
): unknown => {
  switch (repeat.kind) {
    case "done": {
      const at = isoSeconds(repeat.at);
      const next = (args.duplicate ?? 1) + 1;
      return {
        account,
        ...repeat.result,
        repeat_of: at,
        note: `This call already ran at ${at}. Nothing was created or sent again. This is its result.${"duplicate" in tool.expects && next <= 100 ? ` To make one more on purpose, call again with duplicate: ${next}.` : ""}`,
      };
    }
    case "running":
      return {
        status: "running",
        note: "The same call is still running. Call again with the same arguments in a few seconds.",
      };
    case "unknown":
      // executeAccount and createApproval return repeats only for creating tools.
      throw new ToolFailure({
        code: "outcome_unknown",
        said: tool.unknown!(account, repeat.until, args),
      });
  }
};
const notAllowed = (seen: unknown) =>
  new ToolFailure({
    code: seen ? "tool_not_allowed" : "account_not_available",
  });
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
  args: DecodedArgs,
  deadline: number,
  still: Effect.Effect<void, ToolFailure>,
  signal?: AbortSignal,
): Promise<Executed> {
  const requests = accountRequests(ctx, allowed, deadline, signal);
  try {
    if (!tool.create) {
      const result = await Effect.runPromise(
        Effect.result(tool.run(requests.send, { email: allowed.credential.email }, args)),
      );
      if (Result.isFailure(result)) throw result.failure;
      return { kind: "ran", value: result.success };
    }
    const identity = await identityOf(ctx.config.tokenKey, {
      connection: ctx.connection.connectionId,
      account: allowed.credential.id,
      tool: tool.name,
      args: { ...args },
      defaults: tool.defaults,
    });
    const entered = await Effect.runPromise(Effect.result(take(ctx, identity, ctx.now())));
    if (Result.isFailure(entered)) throw new ToolFailure({ code: "server_unavailable" });
    if (entered.success.kind !== "run") return { kind: "repeat", repeat: entered.success };
    const claim = entered.success.claim;
    const reserve = deadline - SEND_RESERVE;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(0, reserve - ctx.now()));
    const unavailable = () => new ToolFailure({ code: "google_unavailable" });
    const send: Send = (build) =>
      requests
        .send((token, signal) => {
          if (ctx.now() >= reserve || controller.signal.aborted) throw unavailable();
          const request = build(token, AbortSignal.any([signal, controller.signal]));
          if (new URL(request.url).pathname.endsWith("/drafts/send")) throw unavailable();
          return request;
        })
        .pipe(
          Effect.mapError((failure) =>
            controller.signal.aborted || ctx.now() >= reserve ? unavailable() : failure,
          ),
        );
    const seen: { started: boolean; status: number | null } = { started: false, status: null };
    const sending = ((build) => {
      let sends = false;
      return requests
        .send((token, signal) => {
          const request = build(token, signal);
          if (request.method === "POST" && new URL(request.url).pathname.endsWith("/drafts/send")) {
            sends = true;
            seen.started = true;
            seen.status = null;
          }
          return request;
        })
        .pipe(
          Effect.tap((response) =>
            Effect.sync(() => {
              if (sends) seen.status = response.status;
            }),
          ),
        );
    }) as Sending;
    const confirm: Confirm = Effect.gen(function* () {
      yield* still;
      if (ctx.now() > reserve) return yield* Effect.fail(unavailable());
      return sending;
    });
    try {
      const result = await Effect.runPromise(
        Effect.result(tool.create(send, { email: allowed.credential.email }, args, confirm)),
      );
      if (Result.isFailure(result)) throw result.failure;
      await Effect.runPromise(
        Effect.result(settle(ctx, claim, ctx.now(), { kind: "done", result: result.success })),
      );
      return { kind: "ran", value: { account: allowed.credential.email, ...result.success } };
    } catch (error) {
      if (
        error instanceof ToolFailure &&
        error.code !== "outcome_unknown" &&
        (!seen.started || (seen.status !== null && seen.status >= 400 && seen.status < 500))
      ) {
        await Effect.runPromise(Effect.result(release(ctx, claim)));
        throw new ToolFailure({
          code: error.code,
          said: error.said,
          missing: error.missing,
          field: error.field,
          reason: error.reason,
          over: error.over,
          unsendable: error.unsendable,
          released: true,
        });
      }
      const now = ctx.now();
      await Effect.runPromise(Effect.result(settle(ctx, claim, now, { kind: "unknown" })));
      throw new ToolFailure({
        code: "outcome_unknown",
        unknown: true,
        said: tool.unknown(allowed.credential.email, now + WINDOW, args),
      });
    } finally {
      clearTimeout(timer);
    }
  } finally {
    requests.close();
  }
}
export function accountRequests(
  ctx: Pick<CallContext, "db" | "config" | "owner" | "now">,
  allowed: Allowed,
  deadline: number,
  signal?: AbortSignal,
): { send: Send; close: () => void } {
  if (allowed.status.kind === "missing_access" || allowed.status.kind === "unreadable")
    throw new ToolFailure({ code: `account_${allowed.status.kind}` });
  // A tool can send several requests at once, so each attempt owns its timer.
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const session = googleSession(ctx, allowed.credential);
  const send: Send = (build) =>
    session((token) => {
      // The session can retry after a 401. Each attempt owns a fresh request and deadline.
      if (ctx.now() >= deadline || signal?.aborted)
        throw new ToolFailure({ code: "google_unavailable", unknown: true });
      const controller = new AbortController();
      timers.add(
        setTimeout(
          () => {
            controller.abort();
          },
          Math.min(10000, deadline - ctx.now()),
        ),
      );
      return build(
        token,
        signal ? AbortSignal.any([controller.signal, signal]) : controller.signal,
      );
    }).pipe(
      Effect.mapError(tokenFailure),
      Effect.catchDefect((defect) =>
        defect instanceof ToolFailure ? Effect.fail(defect) : Effect.die(defect),
      ),
    );
  return {
    send,
    close: () => {
      for (const timer of timers) clearTimeout(timer);
    },
  };
}
export async function runCall(
  ctx: CallContext,
  name: string,
  args: Record<string, unknown> | undefined,
): Promise<CallToolResult> {
  const at = ctx.now();
  let id: CallId | null = null;
  let email = "";
  let toolName = "";
  let input = "";
  let unknownTool = false;
  let result: CallToolResult;
  let outcome: Outcome | null = "success";
  try {
    const tool = TOOLS.find((t) => t.name === name);
    toolName = tool?.name ?? "";
    // This measure must precede any decoding or parsing of the arguments.
    const oversized =
      tool?.kind === "account" &&
      new TextEncoder().encode(JSON.stringify(args)).byteLength > MAX_ARGUMENTS_BYTES;
    if (!oversized) input = typeof args?.account === "string" ? args.account : "";
    const account = tool?.kind === "account" && !oversized ? normalizeEmail(input) : null;
    const statements = [recordStatement(ctx, tool?.name ?? null, account)];
    if (tool?.kind === "account" && account)
      statements.push(
        allowedAccountStatement(ctx, tool.name, account),
        seenAccountStatement(ctx, account),
      );
    const batch = await ctx.db.batch(statements);
    id = decodeCallId(batch[0]!);
    if (!id) throw new ToolFailure({ code: "server_unavailable" });
    if (oversized)
      throw new ToolFailure({ code: "invalid_arguments", reason: "arguments_too_large" });
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
        const decoded = decodeArgs(tool, args);
        if (!decoded.ok) {
          const name = decoded.field ?? "account";
          throw new ToolFailure({
            code: "invalid_arguments",
            field: { name, expects: decoded.expects ?? tool.expects[name] ?? "valid" },
          });
        }
        const row = batch[1]?.results[0];
        if (!row) {
          email = account ?? "";
          throw notAllowed(batch[2]?.results[0]);
        }
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
                ...(tool.create
                  ? {
                      identity: await identityOf(ctx.config.tokenKey, {
                        connection: ctx.connection.connectionId,
                        account: allowed.credential.id,
                        tool: tool.name,
                        args: { ...decoded.value },
                        defaults: tool.defaults,
                      }),
                    }
                  : {}),
              }),
            ),
          );
          if (Result.isFailure(created))
            throw new ToolFailure({ code: "server_unavailable", unknown: true });
          if (typeof created.success === "object") {
            outcome = "repeat";
            value =
              "repeat" in created.success
                ? repeatAnswer(created.success.repeat, email, tool, decoded.value)
                : pendingAnswer(
                    ctx.origin,
                    created.success.waiting.id,
                    created.success.waiting.expiresAt,
                  );
          } else if (created.success !== "created") {
            throw new ToolFailure({
              code:
                created.success === "limit" ? "approval_limit_reached" : "account_not_available",
            });
          } else {
            outcome = null;
            value = pendingAnswer(ctx.origin, approval, at + APPROVAL_LIFETIME);
          }
        } else {
          const executed = await executeAccount(
            ctx,
            tool,
            allowed,
            decoded.value,
            at + CALL_DEADLINE,
            Effect.tryPromise({
              try: () =>
                ctx.db.batch([
                  allowedAccountStatement(ctx, tool.name, account!),
                  seenAccountStatement(ctx, account!),
                ]),
              catch: () => new ToolFailure({ code: "server_unavailable" }),
            }).pipe(
              Effect.flatMap((checked) => {
                const row = checked[0]!.results[0];
                if (!row) return Effect.fail(notAllowed(checked[1]!.results[0]));
                return (row as { ask: unknown }).ask === 0
                  ? Effect.void
                  : Effect.fail(new ToolFailure({ code: "server_unavailable" }));
              }),
            ),
          );
          if (executed.kind === "repeat") {
            outcome = "repeat";
            value = repeatAnswer(executed.repeat, email, tool, decoded.value);
          } else value = executed.value;
        }
      }
      result = { content: [{ type: "text", text: JSON.stringify(value) }] };
    }
  } catch (error) {
    const classified = classify(
      error,
      { approved: false, aborted: false },
      { input, email, origin: ctx.origin, tool: toolName, connection: ctx.connection.connectionId },
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

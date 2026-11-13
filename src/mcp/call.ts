import {
  readApprovalUploads,
  holdUploads,
  releaseUploads,
  dropUploads,
  parseUploadId,
  type UploadRef,
} from "../uploads/store";
import { getFile, type FileData } from "../files/store";
import { checkAttachedSize } from "./attachments";
import { createApproval, waitingApproval } from "../approvals/store";
import { APPROVAL_LIFETIME, CALL_DEADLINE, isoSeconds, type ApprovalId } from "../approvals/model";
import { pendingAnswer } from "../approvals/result";
import { sealArguments } from "../approvals/text";
import { classify, failures, ToolFailure, uploadNotAvailable, uploadNotReady } from "./failures";
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
  type Sources,
  type Uploaded,
} from "./tools";
import { contentOf, takes, type Reader } from "./file";
import { identityOf } from "../once/identity";
import { take, settle, release, WINDOW, type Repeat } from "../once/store";
export const MAX_ARGUMENTS_BYTES = 256 * 1024;
export const SEND_RESERVE = 5_000;
const isSend = (request: Request) => new URL(request.url).pathname.endsWith("/send");
export { CALL_DEADLINE } from "../approvals/model";

export interface CallContext {
  db: D1Database;
  files: KVNamespace;
  reader: Reader;
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
        note: `This call already ran at ${at}. Nothing was created or sent again. This is its result.${"duplicate" in tool.expects && next <= 100 ? ` To make one more on purpose, call again with duplicate: ${next}${tool.uploads?.(args).length ? " and a new upload of each file" : ""}.` : ""}`,
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
const notAllowed = (seen: unknown, about?: ToolFailure["about"]) =>
  new ToolFailure({
    code: seen ? "tool_not_allowed" : "account_not_available",
    ...(about ? { about } : {}),
  });
type Allowed = { credential: Credential; status: AccountStatus };
export type Accounts = { own: Allowed; others: ReadonlyMap<string, Allowed> };
/** Sources never let a tool write as another account. */
export const sourceRead =
  (send: Send): Send =>
  (build) =>
    send((token, signal) => {
      const request = build(token, signal);
      if (request.method !== "GET") throw new ToolFailure({ code: "google_unavailable" });
      return request;
    });
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
/** Bound preparation, including token acquisition, and keep sending behind Confirm. */
export function preparation(now: () => number, reserve: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(0, reserve - now()));
  const unavailable = () => new ToolFailure({ code: "google_unavailable" });
  const stopped = Effect.callback<never, ToolFailure>((resume) => {
    const fail = () => resume(Effect.fail(unavailable()));
    if (controller.signal.aborted) {
      fail();
      return;
    }
    controller.signal.addEventListener("abort", fail, { once: true });
    return Effect.sync(() => controller.signal.removeEventListener("abort", fail));
  });
  const reserved =
    (requests: Send): Send =>
    (build) => {
      let built = false;
      return requests((token, signal) => {
        if (now() >= reserve || controller.signal.aborted) throw unavailable();
        const request = preparing(build(token, AbortSignal.any([signal, controller.signal])));
        built = true;
        return request;
      }).pipe(
        // Token acquisition can be waiting before a request is built. It shares the reserve.
        Effect.raceFirst(stopped),
        Effect.mapError((failure) =>
          controller.signal.aborted || now() >= reserve
            ? new ToolFailure({
                code: "google_unavailable",
                ...(built ? { unknown: true } : {}),
              })
            : failure,
        ),
      );
    };
  const bound = <A, E>(effect: Effect.Effect<A, E>) =>
    effect.pipe(
      Effect.raceFirst(stopped),
      Effect.flatMap((value) =>
        now() >= reserve || controller.signal.aborted
          ? Effect.fail(unavailable())
          : Effect.succeed(value),
      ),
    );
  return { wrap: reserved, bound, close: () => clearTimeout(timer) };
}
const preparing = (request: Request) => {
  if (isSend(request)) throw new ToolFailure({ code: "google_unavailable" });
  return request;
};
export async function executeAccount(
  ctx: CallContext,
  tool: Extract<Tool, { kind: "account" }>,
  accounts: Accounts,
  args: DecodedArgs,
  deadline: number,
  still: Effect.Effect<void, ToolFailure>,
  held: ReadonlyMap<string, FileData> | null = null,
  signal?: AbortSignal,
): Promise<Executed> {
  const allowed = accounts.own;
  const requests = accountRequests(ctx, allowed, deadline, signal);
  const otherRequests = new Map<string, ReturnType<typeof accountRequests>>();
  try {
    if (!tool.create) {
      const result = await Effect.runPromise(
        Effect.result(
          tool.run(requests.send, { email: allowed.credential.email }, args, takes(ctx.reader)),
        ),
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
    const preparingRequests = preparation(ctx.now, reserve);
    const unavailable = () => new ToolFailure({ code: "google_unavailable" });
    const send = preparingRequests.wrap(requests.send);
    const seen: { started: boolean; status: number | null } = { started: false, status: null };
    const sending = ((build) => {
      let sends = false;
      return requests
        .send((token, signal) => {
          // A retry here follows a 401, which sent nothing. Start a new call and check again.
          if (sends) {
            seen.status = 401;
            throw unavailable();
          }
          const request = build(token, signal);
          if (isSend(request)) {
            sends = true;
            seen.started = true;
            seen.status = null;
          }
          return request;
        })
        .pipe(
          Effect.mapError((failure) => {
            // A classified token failure after building the send follows its 401 response.
            if (sends && !failure.unknown) seen.status = 401;
            return failure;
          }),
          Effect.tap((response) =>
            Effect.sync(() => {
              if (sends) seen.status = response.status;
            }),
          ),
        );
    }) as Sending;
    const late: Send = (build) => requests.send((token, signal) => preparing(build(token, signal)));
    const confirm: Confirm = {
      late,
      check: Effect.gen(function* () {
        yield* still;
        if (ctx.now() > reserve) return yield* Effect.fail(unavailable());
        return sending;
      }),
    };
    const ids = (tool.uploads?.(args) ?? []).map((id) => parseUploadId(id)!);
    try {
      const uploads =
        held === null
          ? await Effect.runPromise(
              holdUploads(ctx, ids, identity).pipe(
                Effect.mapError(() => new ToolFailure({ code: "server_unavailable" })),
              ),
            )
          : { refs: new Map<string, UploadRef>(), missing: null };
      if (uploads.missing) throw uploadNotAvailable(uploads.missing);
      const sources: Sources = {
        from: (input) => {
          const email = normalizeEmail(input);
          const source = email ? accounts.others.get(email) : undefined;
          if (!source)
            return () =>
              Effect.fail(
                new ToolFailure({ code: "account_not_available", about: { input, email: input } }),
              );
          let request = otherRequests.get(email!);
          if (!request) {
            request = accountRequests(ctx, source, deadline, signal);
            otherRequests.set(email!, request);
          }
          return sourceRead(preparingRequests.wrap(request.send));
        },
        uploads: new Map<string, Uploaded>(
          held === null
            ? Array.from(uploads.refs, ([id, ref]) => [
                id,
                {
                  ...ref,
                  bytes: preparingRequests.bound(getFile(ctx.files, ref)).pipe(
                    Effect.mapError(() => uploadNotReady()),
                    Effect.flatMap((file) =>
                      file ? Effect.succeed(file.bytes) : Effect.fail(uploadNotReady()),
                    ),
                  ),
                },
              ])
            : Array.from(held, ([id, file]) => [
                id,
                { ...file, size: file.bytes.byteLength, bytes: Effect.succeed(file.bytes) },
              ]),
        ),
      };
      const result = await Effect.runPromise(
        Effect.result(
          tool.create(send, { email: allowed.credential.email }, args, confirm, sources),
        ),
      );
      if (Result.isFailure(result)) throw result.failure;
      await Effect.runPromise(
        Effect.result(settle(ctx, claim, ctx.now(), { kind: "done", result: result.success })),
      );
      if (held === null && ids.length)
        await Effect.runPromise(Effect.result(dropUploads(ctx, ids, identity)));
      return { kind: "ran", value: { account: allowed.credential.email, ...result.success } };
    } catch (error) {
      if (
        error instanceof ToolFailure &&
        error.code !== "outcome_unknown" &&
        (!seen.started || (seen.status !== null && seen.status >= 400 && seen.status < 500))
      ) {
        await Effect.runPromise(Effect.result(release(ctx, claim)));
        if (held === null && ids.length)
          await Effect.runPromise(Effect.result(releaseUploads(ctx, ids, identity)));
        const data: ConstructorParameters<typeof ToolFailure>[0] = error;
        const { unknown: _unknown, ...known } = data;
        throw new ToolFailure({ ...known, released: true });
      }
      const now = ctx.now();
      await Effect.runPromise(Effect.result(settle(ctx, claim, now, { kind: "unknown" })));
      if (held === null && ids.length)
        await Effect.runPromise(Effect.result(dropUploads(ctx, ids, identity)));
      throw new ToolFailure({
        code: "outcome_unknown",
        unknown: true,
        said: tool.unknown(allowed.credential.email, now + WINDOW, args),
      });
    } finally {
      preparingRequests.close();
    }
  } finally {
    requests.close();
    for (const request of otherRequests.values()) request.close();
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
  const tool = TOOLS.find((t) => t.name === name);
  let id: CallId | null = null;
  let email = "";
  let input = "";
  let unknownTool = false;
  let result: CallToolResult;
  let outcome: Outcome | null = "success";
  try {
    // This measure must precede any decoding or parsing of the arguments.
    const oversized =
      tool?.kind === "account" &&
      new TextEncoder().encode(JSON.stringify(args)).byteLength > MAX_ARGUMENTS_BYTES;
    if (!oversized) input = typeof args?.account === "string" ? args.account : "";
    const account = tool?.kind === "account" && !oversized ? normalizeEmail(input) : null;
    const decoded = tool?.kind === "account" && !oversized ? decodeArgs(tool, args) : null;
    const otherUses =
      tool?.kind === "account" && decoded?.ok ? (tool.also?.(decoded.value) ?? []) : [];
    const pairs =
      tool?.kind === "account" ? [{ account: input, tool: tool.name }, ...otherUses] : [];
    const checks = () =>
      pairs.flatMap((pair) => {
        const email = normalizeEmail(pair.account);
        // A missing address gets empty results too, without disclosing any account.
        return email
          ? [
              allowedAccountStatement(
                ctx,
                pair.tool as Extract<Tool, { kind: "account" }>["name"],
                email,
              ),
              seenAccountStatement(ctx, email),
            ]
          : [ctx.db.prepare("SELECT 1 WHERE 0"), ctx.db.prepare("SELECT 1 WHERE 0")];
      });
    const statements = [
      recordStatement(
        ctx,
        tool?.name ?? null,
        account,
        otherUses.flatMap((use) => {
          const email = normalizeEmail(use.account);
          return email ? [{ account: email, tool: use.tool }] : [];
        }),
      ),
      ...(!oversized && decoded?.ok ? checks() : []),
    ];
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
        if (!decoded || !decoded.ok) {
          const name = decoded && !decoded.ok ? (decoded.field ?? "account") : "account";
          throw new ToolFailure({
            code: "invalid_arguments",
            field: {
              name,
              expects:
                (decoded && !decoded.ok ? decoded.expects : undefined) ??
                tool.expects[name] ??
                "valid",
            },
          });
        }
        const checked: Allowed[] = [];
        const ask = pairs.some((_, i) => {
          const row = batch[1 + i * 2]?.results[0] as { ask: unknown } | undefined;
          return row && row.ask !== 0;
        });
        for (const [i, pair] of pairs.entries()) {
          const row = batch[1 + i * 2]?.results[0];
          const about = i
            ? {
                input: pair.account,
                email: normalizeEmail(pair.account) ?? pair.account,
                tool: pair.tool,
              }
            : undefined;
          if (!row) {
            if (!i) email = account ?? "";
            throw notAllowed(batch[2 + i * 2]?.results[0], about);
          }
          const allowed = await decodeAllowedAccount(row, ctx.config.tokenKey);
          checked.push(allowed);
          if (!i) email = allowed.credential.email;
          if (
            (i || ask) &&
            ["needs_reconnect", "missing_access", "unreadable"].includes(allowed.status.kind)
          )
            throw new ToolFailure({
              code: `account_${allowed.status.kind}` as
                | "account_needs_reconnect"
                | "account_missing_access"
                | "account_unreadable",
              ...(about ? { about } : {}),
            });
        }
        const allowed = checked[0]!;
        const accounts: Accounts = {
          own: allowed,
          others: new Map(checked.slice(1).map((value) => [value.credential.email, value])),
        };
        if (ask) {
          const approval = crypto.randomUUID() as ApprovalId;
          const ids = (tool.uploads?.(decoded.value) ?? []).map((id) => parseUploadId(id)!);
          const identity = tool.create
            ? await identityOf(ctx.config.tokenKey, {
                connection: ctx.connection.connectionId,
                account: allowed.credential.id,
                tool: tool.name,
                args: { ...decoded.value },
                defaults: tool.defaults,
              })
            : null;
          const refs = await Effect.runPromise(readApprovalUploads(ctx, ids, identity));
          const found = ids.every((id) => refs.has(id));
          if (found) {
            const body = (decoded.value as DecodedArgs & { body?: string }).body ?? "";
            await Effect.runPromise(
              checkAttachedSize(
                Array.from(refs.values(), (ref) => ref.size),
                new TextEncoder().encode(body).byteLength,
              ),
            );
          }
          const argumentsSealed = await sealArguments(
            ctx.config.tokenKey,
            approval,
            decoded.value,
            Object.fromEntries(refs),
          );
          // Once the batch starts, its lost response must never close the audit record.
          const created = await Effect.runPromise(
            Effect.result(
              createApproval(ctx, {
                id: approval,
                call: id,
                tool: tool.name,
                uses: checked.map((value, i) => ({
                  account: value.credential.id,
                  tool: pairs[i]!.tool as typeof tool.name,
                })),
                uploads: { ids, found },
                arguments: argumentsSealed,
                at,
                ...(identity ? { identity } : {}),
              }),
            ),
          );
          if (Result.isFailure(created))
            throw new ToolFailure({ code: "server_unavailable", unknown: true });
          if (typeof created.success === "object") {
            if ("upload" in created.success) throw uploadNotAvailable(created.success.upload);
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
          const waiting = tool.create
            ? await Effect.runPromise(
                waitingApproval(
                  ctx,
                  await identityOf(ctx.config.tokenKey, {
                    connection: ctx.connection.connectionId,
                    account: allowed.credential.id,
                    tool: tool.name,
                    args: { ...decoded.value },
                    defaults: tool.defaults,
                  }),
                  ctx.now(),
                ),
              )
            : null;
          if (waiting) {
            outcome = "repeat";
            value = pendingAnswer(ctx.origin, waiting.id, waiting.expiresAt);
          } else {
            const executed = await executeAccount(
              ctx,
              tool,
              accounts,
              decoded.value,
              at + CALL_DEADLINE,
              Effect.tryPromise({
                try: () => ctx.db.batch(checks()),
                catch: () => new ToolFailure({ code: "server_unavailable" }),
              }).pipe(
                Effect.flatMap((checked) => {
                  for (const [i, pair] of pairs.entries()) {
                    const row = checked[i * 2]!.results[0];
                    const about = i
                      ? {
                          input: pair.account,
                          email: normalizeEmail(pair.account) ?? pair.account,
                          tool: pair.tool,
                        }
                      : undefined;
                    if (!row) return Effect.fail(notAllowed(checked[i * 2 + 1]!.results[0], about));
                    if ((row as { ask: unknown }).ask !== 0)
                      return Effect.fail(new ToolFailure({ code: "server_unavailable" }));
                  }
                  return Effect.void;
                }),
              ),
            );
            if (executed.kind === "repeat") {
              outcome = "repeat";
              value = repeatAnswer(executed.repeat, email, tool, decoded.value);
            } else value = executed.value;
          }
        }
      }
      result = { content: contentOf(value, ctx.reader) };
    }
  } catch (error) {
    const classified = classify(
      error,
      { approved: false, aborted: false },
      {
        input,
        email,
        origin: ctx.origin,
        tool: tool?.name ?? "",
        connection: ctx.connection.connectionId,
        // Only run tools use the generic uncertain-change wording. A create tool marks its
        // creating or sending request and reports a possible leftover draft separately.
        annotations: tool?.kind === "account" && tool.create ? undefined : tool?.annotations,
      },
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

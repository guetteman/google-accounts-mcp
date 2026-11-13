import { Effect } from "effect";
import { decodeAllowedAccount } from "../accounts/store";
import type { Config } from "../config";
import { getFile, type FileData, putFile } from "../files/store";
import { WithFile } from "../mcp/file";
import { WriteUncertain } from "../db";
import {
  accountRequests,
  sourceRead,
  preparation,
  SEND_RESERVE,
  CALL_DEADLINE,
  executeAccount,
  repeatAnswer,
  type CallContext,
} from "../mcp/call";
import { classify, ToolFailure } from "../mcp/failures";
import type { Outcome } from "../calls/store";
import {
  RUN_DEADLINE,
  RESULT_LIFETIME,
  type Approval,
  type ApprovalId,
  type ApprovalPageProps,
  type StoredPayload,
  type Won,
} from "./model";
import {
  decideApproval,
  finishApproval,
  readApproval,
  viewCredential,
  stillApproved,
  type ApprovalContext,
} from "./store";
import { openResult, sealResult } from "./text";
import type { Send, Tool, DecodedArgs } from "../mcp/tools";
import { WINDOW } from "../once/store";
import { approvalView } from "./view";

type Dependencies = ApprovalContext & { config: Config; origin: string; files: KVNamespace };
/** Every unknown create outcome retains the tool's own recovery instructions. */
async function unknownNotice(
  deps: Dependencies,
  id: ApprovalId,
  tool: Extract<Tool, { kind: "account" }>,
  email: string,
  args: DecodedArgs,
) {
  return tool.create
    ? sealResult(deps.config.tokenKey, id, {
        error: { code: "outcome_unknown", message: tool.unknown(email, Date.now() + WINDOW, args) },
      })
    : null;
}
async function viewOf(
  approval: Approval,
  deps: ApprovalContext & { config: Config },
  changed = false,
  reads?: { deadline: number; signal?: AbortSignal },
) {
  const payload =
    approval.state === "finished" &&
    (approval.outcome === "failed" || approval.outcome === "unknown") &&
    approval.result !== null
      ? await openResult(deps.config.tokenKey, approval.id, approval.result)
      : null;
  const preparing = reads ? preparation(Date.now, reads.deadline - SEND_RESERVE) : null;
  const requests = new Map<string, ReturnType<typeof accountRequests>>();
  const sourceIds = new Set(approval.uses.slice(1).map((use) => use.account));
  let loading: Promise<Awaited<ReturnType<typeof decodeAllowedAccount>>[]> | undefined;
  const from = (account: string, source = false): Send =>
    sourceRead((build) =>
      Effect.gen(function* () {
        loading ??= Effect.runPromise(viewCredential(deps, approval.id, Date.now())).then((rows) =>
          Promise.all(rows.map((row) => decodeAllowedAccount(row, deps.config.tokenKey))),
        );
        const all = yield* Effect.tryPromise({
          try: () => loading!,
          catch: () => new ToolFailure({ code: "server_unavailable" }),
        });
        const allowed = all.find(
          (value) =>
            value.credential.email === account && (!source || sourceIds.has(value.credential.id)),
        );
        if (!allowed) return yield* Effect.fail(new ToolFailure({ code: "account_not_available" }));
        let request = requests.get(account);
        if (!request) {
          request = accountRequests(
            { ...deps, now: Date.now },
            allowed,
            reads!.deadline,
            reads!.signal,
          );
          requests.set(account, request);
        }
        return yield* request.send(build);
      }),
    );
  const own = approval.accounts.find((account) => account.id === approval.uses[0]?.account);
  try {
    return await approvalView(
      approval,
      deps.config.tokenKey,
      Date.now(),
      changed,
      payload && "error" in payload ? payload.error.message : null,
      reads && own
        ? {
            send: from(own.email),
            from: (account) => preparing!.wrap(from(account.trim().toLowerCase(), true)),
          }
        : undefined,
    );
  } finally {
    preparing?.close();
    for (const request of requests.values()) request.close();
  }
}
export const readApprovalPage = (
  deps: ApprovalContext & { config: Config },
  id: ApprovalId,
  changed = false,
) =>
  Effect.tryPromise({
    try: async () => {
      const approval = await Effect.runPromise(readApproval(deps, id, Date.now()));
      return approval
        ? (await viewOf(approval, deps, changed, { deadline: Date.now() + CALL_DEADLINE })).page
        : null;
    },
    catch: () => new WriteUncertain(),
  });

export const decide = (
  deps: Dependencies,
  input: { id: ApprovalId; action: "approve" | "reject"; digest: string | null; arrivedAt: number },
): Effect.Effect<ApprovalPageProps | null, WriteUncertain> =>
  Effect.tryPromise({
    try: async () => {
      const { id, action } = input;
      const deadline = input.arrivedAt + RUN_DEADLINE;
      const controller = new AbortController();
      let winner: Won | null = null;
      let notice: () => ReturnType<typeof unknownNotice> = async () => null;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = () => controller.signal.aborted || Date.now() >= deadline;
      const readPage = async (changed = false) => {
        const row = await Effect.runPromise(readApproval(deps, id, Date.now()));
        return row
          ? (
              await viewOf(
                row,
                deps,
                changed,
                action === "approve" ? { deadline, signal: controller.signal } : undefined,
              )
            ).page
          : null;
      };
      const work = async () => {
        const approval = await Effect.runPromise(readApproval(deps, id, Date.now()));
        if (!approval) return null;
        const view = await viewOf(
          approval,
          deps,
          false,
          action === "approve" ? { deadline, signal: controller.signal } : undefined,
        );
        switch (approval.state) {
          case "running":
          case "finished":
          case "rejected":
          case "expired":
          case "refused":
            return view.page;
          case "waiting":
            break;
        }
        if (action === "approve") {
          if (!view.decoded) return view.page;
          if (
            typeof input.digest !== "string" ||
            input.digest.length === 0 ||
            view.page.state.kind !== "waiting" ||
            typeof view.page.state.digest !== "string" ||
            (!view.tool.view.asItIs && view.page.state.digest !== input.digest)
          )
            return readPage(true);
        }
        const held = new Map<string, FileData>();
        if (action === "approve") {
          await Promise.all(
            Object.entries(view.files).map(async ([id, ref]) => {
              const file = await Effect.runPromise(getFile(deps.files, ref));
              if (!file) throw new WriteUncertain();
              held.set(id, file);
            }),
          );
        }
        if (
          late() ||
          (action === "approve" && view.tool.create && Date.now() >= deadline - SEND_RESERVE)
        )
          throw new WriteUncertain();
        const decision = await Effect.runPromise(
          decideApproval(deps, { id, at: input.arrivedAt, action }),
        );
        if (!decision.won) return readPage(true);
        if (action === "reject") return readPage();
        winner = decision.won;
        const args = view.decoded;
        if (!args) throw new WriteUncertain();
        notice = () => unknownNotice(deps, id, view.tool, view.page.request.account.email, args);
        // A late decision response cannot start Google work after the request's deadline.
        if (late()) {
          await Effect.runPromise(
            finishApproval(deps, decision.won, Date.now(), "unknown", null, await notice()),
          );
          return readPage();
        }
        const call: CallContext = {
          ...deps,
          connection: { connectionId: approval.connection.id, app: approval.connection.app },
          now: Date.now,
          reader: approval.connection.app === "chatgpt" ? { client: null } : "later",
          waitUntil: () => {},
        };
        let outcome: "success" | "failed" | "unknown" = "success";
        let audit: Outcome | null = "success";
        let payload: StoredPayload | null = null;
        let retainNotice = false;
        try {
          const all = await Promise.all(
            decision.credentials.map((row) => decodeAllowedAccount(row, deps.config.tokenKey)),
          );
          const allowed = all.find((value) => value.credential.id === approval.uses[0]!.account);
          if (!allowed) throw new WriteUncertain();
          const accounts = {
            own: allowed,
            others: new Map(
              all
                .filter((value) =>
                  approval.uses.slice(1).some((use) => use.account === value.credential.id),
                )
                .map((value) => [value.credential.email, value]),
            ),
          };
          const executed = await executeAccount(
            call,
            view.tool,
            accounts,
            args,
            deadline,
            stillApproved(deps, decision.won),
            held,
            controller.signal,
          );
          if (executed.kind === "ran") {
            const out = executed.value;
            if (out instanceof WithFile) {
              const ref = await Effect.runPromise(
                putFile(deps.files, out.file, decision.won.at + RESULT_LIFETIME),
              );
              payload = { result: out.value, file: ref };
            } else payload = { result: out };
          } else {
            audit = "repeat";
            if (executed.repeat.kind === "done")
              payload = {
                result: repeatAnswer(executed.repeat, allowed.credential.email, view.tool, args),
              };
            else {
              outcome = "unknown";
              retainNotice = true;
            }
          }
        } catch (error) {
          const classified = classify(
            error,
            { approved: true, aborted: late() },
            {
              input: args.account,
              email: view.page.request.account.email,
              origin: deps.origin,
              tool: approval.tool,
              connection: approval.connection.id,
            },
          );
          audit = classified.audit;
          retainNotice = Boolean(
            view.tool.create && error instanceof ToolFailure && error.code === "outcome_unknown",
          );
          outcome = retainNotice || classified.error === null ? "unknown" : "failed";
          payload = classified.error === null ? null : { error: classified.error };
        }
        const result = retainNotice
          ? await notice()
          : payload === null
            ? null
            : await sealResult(deps.config.tokenKey, id, payload);
        await Effect.runPromise(
          finishApproval(deps, decision.won, Date.now(), outcome, audit, result),
        );
        return readPage();
      };
      try {
        const timedOut = new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => {
              controller.abort();
              reject(new WriteUncertain());
            },
            Math.max(0, deadline - Date.now()),
          );
        });
        return await Promise.race([work(), timedOut]);
      } catch (error) {
        if (controller.signal.aborted && winner) {
          await Effect.runPromise(
            finishApproval(deps, winner, Date.now(), "unknown", null, await notice()),
          );
          const page = await readPage();
          if (page && page.state.kind !== "waiting") return page;
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },
    catch: () => new WriteUncertain(),
  });

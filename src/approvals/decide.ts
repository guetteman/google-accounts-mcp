import { Effect } from "effect";
import { decodeAllowedAccount } from "../accounts/store";
import type { Config } from "../config";
import { WriteUncertain } from "../db";
import { executeAccount, type CallContext } from "../mcp/call";
import { classify } from "../mcp/failures";
import type { Outcome } from "../calls/store";
import {
  RUN_DEADLINE,
  type Approval,
  type ApprovalId,
  type ApprovalPageProps,
  type StoredPayload,
  type Won,
} from "./model";
import { decideApproval, finishApproval, readApproval, type ApprovalContext } from "./store";
import { openResult, sealResult } from "./text";
import { approvalView } from "./view";

type Dependencies = ApprovalContext & { config: Config; origin: string };
async function viewOf(approval: Approval, deps: Pick<Dependencies, "config">, changed = false) {
  const payload =
    approval.state === "finished" && approval.outcome === "failed" && approval.result !== null
      ? await openResult(deps.config.tokenKey, approval.id, approval.result)
      : null;
  return approvalView(
    approval,
    deps.config.tokenKey,
    Date.now(),
    changed,
    payload && "error" in payload ? payload.error.message : null,
  );
}
export const readApprovalPage = (
  deps: ApprovalContext & { config: Config },
  id: ApprovalId,
  changed = false,
) =>
  Effect.tryPromise({
    try: async () => {
      const approval = await Effect.runPromise(readApproval(deps, id, Date.now()));
      return approval ? (await viewOf(approval, deps, changed)).page : null;
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
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = () => controller.signal.aborted || Date.now() >= deadline;
      const readPage = (changed = false) => Effect.runPromise(readApprovalPage(deps, id, changed));
      const work = async () => {
        const approval = await Effect.runPromise(readApproval(deps, id, Date.now()));
        if (!approval) return null;
        const view = await viewOf(approval, deps);
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
            view.page.state.digest !== input.digest
          )
            return readPage(true);
        }
        if (late()) throw new WriteUncertain();
        const decision = await Effect.runPromise(
          decideApproval(deps, { id, at: input.arrivedAt, action }),
        );
        if (!decision.won) return readPage(true);
        if (action === "reject") return readPage();
        winner = decision.won;
        // A late decision response cannot start Google work after the request's deadline.
        if (late()) {
          await Effect.runPromise(
            finishApproval(deps, decision.won, Date.now(), "unknown", null, null),
          );
          return readPage();
        }
        const args = view.decoded;
        if (!args) throw new WriteUncertain();
        const call: CallContext = {
          ...deps,
          connection: { connectionId: approval.connection.id, app: approval.connection.app },
          now: Date.now,
        };
        let outcome: "success" | "failed" | "unknown" = "success";
        let audit: Outcome | null = "success";
        let payload: StoredPayload | null = null;
        try {
          const allowed = await decodeAllowedAccount(decision.credentials[0], deps.config.tokenKey);
          payload = {
            result: await executeAccount(
              call,
              view.tool,
              allowed,
              args,
              deadline,
              controller.signal,
            ),
          };
        } catch (error) {
          const classified = classify(
            error,
            { approved: true, aborted: late() },
            {
              input: args.account,
              email: view.page.request.account.email,
              origin: deps.origin,
            },
          );
          audit = classified.audit;
          outcome = classified.error === null ? "unknown" : "failed";
          payload = classified.error === null ? null : { error: classified.error };
        }
        const result =
          payload === null ? null : await sealResult(deps.config.tokenKey, id, payload);
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
          await Effect.runPromise(finishApproval(deps, winner, Date.now(), "unknown", null, null));
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

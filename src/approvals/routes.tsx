import { Effect } from "effect";
import { Hono } from "hono";
import type { PageEnv } from "../http/context";
import { readForm } from "../http/form";
import { ownerOnly } from "../owner/routes";
import { renderPage } from "../pages/render";
import { decodeAllowedAccount } from "../accounts/store";
import { executeAccount, failures, ToolFailure, type CallContext } from "../mcp/call";
import { seal } from "../seal";
import { parseApprovalId, type StoredPayload } from "./model";
import { decideApproval, finishApproval, readApproval } from "./store";
import { approvalView } from "./view";

export const approvalRoutes = new Hono<PageEnv & { Variables: { approvalArrival: number } }>();
approvalRoutes.use("/approvals/*", async (c, next) => {
  c.set("approvalArrival", Date.now());
  await next();
});
approvalRoutes.get("/approvals/:id", ownerOnly, async (c) => {
  const id = parseApprovalId(c.req.param("id"));
  if (!id) return c.notFound();
  try {
    const row = await Effect.runPromise(
      readApproval({ db: c.env.DB, owner: c.get("owner") }, id, Date.now()),
    );
    if (!row) return c.notFound();
    return renderPage((await approvalView(row, c.get("config").tokenKey, Date.now())).page);
  } catch {
    return renderPage({ _tag: "Unavailable" }, { status: 503 });
  }
});
for (const action of ["approve", "reject"] as const) {
  approvalRoutes.post(`/approvals/:id/${action}`, ownerOnly, readForm, async (c) => {
    const id = parseApprovalId(c.req.param("id"));
    if (!id) return c.json({ outcome: "not_found" }, 404);
    const ctx = { db: c.env.DB, owner: c.get("owner") };
    const config = c.get("config");
    const at = c.get("approvalArrival");
    const deadline = at + 25000;
    const controller = new AbortController();
    const readPage = async (changed = false) => {
      const row = await Effect.runPromise(readApproval(ctx, id, Date.now()));
      return row ? (await approvalView(row, config.tokenKey, Date.now(), changed)).page : null;
    };
    const work = async () => {
      const row = await Effect.runPromise(readApproval(ctx, id, Date.now()));
      if (!row) return null;
      const view = await approvalView(row, config.tokenKey, Date.now());
      if (row.state !== "waiting") return view.page;
      if (action === "approve") {
        if (!view.decoded) return view.page;
        const submittedDigest = c.get("form").get("digest");
        if (
          typeof submittedDigest !== "string" ||
          submittedDigest.length === 0 ||
          view.page.state.kind !== "waiting" ||
          typeof view.page.state.digest !== "string" ||
          view.page.state.digest !== submittedDigest
        ) {
          return readPage(true);
        }
      }
      if (controller.signal.aborted || Date.now() >= deadline) throw new Error("Approval deadline");
      const decision = await Effect.runPromise(
        decideApproval(ctx, {
          id,
          at,
          claim: crypto.randomUUID(),
          action,
          snapshot: view.snapshot,
        }),
      );
      if (!decision.won) return readPage(true);
      if (action === "reject") return readPage();
      // A late decision response must not start Google work after the request's deadline.
      if (controller.signal.aborted || Date.now() >= deadline) {
        await Effect.runPromise(finishApproval(ctx, id, Date.now(), "unknown", null, null, false));
        return readPage();
      }
      const call: CallContext = {
        ...ctx,
        config,
        connection: { connectionId: row.connection_id, app: row.app },
        origin: new URL(c.req.url).origin,
        now: Date.now,
      };
      let outcome: "success" | "failed" | "unknown" = "success";
      let auditOutcome: import("../calls/store").Outcome | null = "success";
      let payload: StoredPayload | null = null;
      try {
        const allowed = await decodeAllowedAccount(decision.credentials[0], config.tokenKey);
        payload = {
          result: await executeAccount(
            call,
            view.tool,
            allowed,
            view.decoded!,
            deadline,
            controller.signal,
          ),
        };
      } catch (error) {
        if (
          !(error instanceof ToolFailure) ||
          error.unknown ||
          error.code === "server_unavailable" ||
          controller.signal.aborted ||
          Date.now() >= deadline
        ) {
          outcome = "unknown";
          auditOutcome = null;
        } else {
          outcome = "failed";
          auditOutcome = failures[error.code].outcome;
          payload = {
            error: {
              code: error.code,
              message: failures[error.code].message(
                view.decoded!.account,
                view.page.request.account.email,
                call.origin,
              ),
            },
          };
        }
      }
      const json = payload === null ? null : JSON.stringify(payload);
      const tooLarge = json !== null && new TextEncoder().encode(json).byteLength > 1_000_000;
      const result =
        json !== null && !tooLarge ? await seal(config.tokenKey, `${id}:result`, json) : null;
      await Effect.runPromise(
        finishApproval(ctx, id, Date.now(), outcome, auditOutcome, result, tooLarge),
      );
      return readPage();
    };
    const respond = async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const timedOut = new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => {
              controller.abort();
              reject(new Error("Approval deadline"));
            },
            Math.max(0, deadline - Date.now()),
          );
        });
        const page = await Promise.race([work(), timedOut]);
        return page ? c.json({ approval: page }) : c.json({ outcome: "not_found" }, 404);
      } catch {
        if (controller.signal.aborted) {
          try {
            await Effect.runPromise(
              finishApproval(ctx, id, Date.now(), "unknown", null, null, false),
            );
            const page = await readPage();
            if (page && page.state.kind !== "waiting") return c.json({ approval: page });
          } catch {
            /* The owner must reload after an uncertain write. */
          }
        }
        return c.json({ outcome: "unknown" }, 503);
      } finally {
        clearTimeout(timer);
      }
    };
    const promise = respond();
    c.executionCtx.waitUntil(promise);
    return await promise;
  });
}

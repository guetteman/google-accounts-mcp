import { Effect } from "effect";
import { Hono } from "hono";
import type { PageEnv } from "../http/context";
import { readForm } from "../http/form";
import { ownerOnly } from "../owner/routes";
import { renderPage } from "../pages/render";
import { parseApprovalId } from "./model";
import { decide, readApprovalPage } from "./decide";

export const approvalRoutes = new Hono<PageEnv & { Variables: { approvalArrival: number } }>();
approvalRoutes.use("/approvals/*", async (c, next) => {
  c.set("approvalArrival", Date.now());
  await next();
});
approvalRoutes.get("/approvals/:id", ownerOnly, async (c) => {
  const id = parseApprovalId(c.req.param("id"));
  if (!id) return c.notFound();
  try {
    const page = await Effect.runPromise(
      readApprovalPage({ db: c.env.DB, owner: c.get("owner"), config: c.get("config") }, id),
    );
    return page ? renderPage(page) : c.notFound();
  } catch {
    return renderPage({ _tag: "Unavailable" }, { status: 503 });
  }
});
for (const action of ["approve", "reject"] as const) {
  approvalRoutes.post(`/approvals/:id/${action}`, ownerOnly, readForm, async (c) => {
    const id = parseApprovalId(c.req.param("id"));
    if (!id) return c.json({ outcome: "not_found" }, 404);
    const digest = c.get("form").get("digest");
    const promise = Effect.runPromise(
      decide(
        {
          db: c.env.DB,
          files: c.env.FILES_KV,
          owner: c.get("owner"),
          config: c.get("config"),
          origin: new URL(c.req.url).origin,
        },
        {
          id,
          action,
          digest: typeof digest === "string" ? digest : null,
          arrivedAt: c.get("approvalArrival"),
        },
      ),
    ).then(
      (page) => (page ? c.json({ approval: page }) : c.json({ outcome: "not_found" }, 404)),
      () => c.json({ outcome: "unknown" }, 503),
    );
    c.executionCtx.waitUntil(promise);
    return await promise;
  });
}

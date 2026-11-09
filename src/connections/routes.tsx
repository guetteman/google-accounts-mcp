import { Effect, Result } from "effect";
import { Hono } from "hono";
import type { PageEnv } from "../http/context";
import { ownerOnly } from "../owner/routes";
import { renderPage } from "../pages/render";
import { parseConnectionId, parseName } from "./model";
import { listConnections, renameConnection, revokeConnection } from "./store";

export const connectionRoutes = new Hono<PageEnv>();
connectionRoutes.get("/connections", ownerOnly, async (c) => {
  const owner = c.get("owner");
  const connections = await Effect.runPromise(
    Effect.result(listConnections(c.env.DB, owner, Date.now())),
  );
  if (Result.isFailure(connections)) return renderPage({ _tag: "Unavailable" }, { status: 503 });
  const url = new URL(c.req.url);
  return renderPage({
    _tag: "Connections",
    frame: { host: url.host, ownerEmail: owner.email, current: "connections" },
    connections: connections.success,
    mcpUrl: `${url.origin}/mcp`,
  });
});
for (const action of ["name", "revoke"] as const) {
  connectionRoutes.post(`/connections/:id/${action}`, ownerOnly, async (c) => {
    const id = parseConnectionId(c.req.param("id"));
    if (!id) return c.json({ outcome: "not_found" }, 404);
    const owner = c.get("owner");
    const name = action === "name" ? parseName((await c.req.raw.formData()).get("name")) : null;
    if (action === "name" && !name) return c.json({ outcome: "invalid" }, 400);
    const result = await Effect.runPromise(
      Effect.result<
        string | { grantId: string },
        import("./store").WriteUncertain | import("../db").Unavailable,
        never
      >(
        action === "name"
          ? renameConnection(c.env.DB, owner, id, name!, Date.now())
          : revokeConnection(c.env.DB, owner, id, Date.now()),
      ),
    );
    if (Result.isFailure(result))
      return c.json(
        { outcome: result.failure._tag === "WriteUncertain" ? "unknown" : "unavailable" },
        503,
      );
    if (typeof result.success === "object") {
      const helper = c.env.OAUTH_PROVIDER;
      if (helper)
        c.executionCtx.waitUntil(
          helper.revokeGrant(result.success.grantId, id).catch(() => {
            console.error("Connection grant cleanup failed");
          }),
        );
      return c.json({ outcome: "ok" });
    }
    return c.json({ outcome: result.success }, result.success === "not_found" ? 404 : 200);
  });
}

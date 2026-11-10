import { Unavailable } from "../db";
import { readForm } from "../http/form";
import { Effect, Result } from "effect";
import { Hono } from "hono";
import type { PageEnv } from "../http/context";
import { ownerOnly } from "../owner/routes";
import { renderPage } from "../pages/render";
import { parseConnectionId } from "./model";
import { parseName } from "../names";
import {
  listConnections,
  connectionsStatement,
  decodeConnections,
  renameConnection,
  revokeConnection,
} from "./store";

import { parseAccountId } from "../accounts/model";
import { GMAIL_SCOPES } from "../google/client";
import { accountsStatement, decodeAccounts } from "../accounts/store";
import { permissionsStatement, decodePermissions } from "../permissions/store";
import { TOOLS, parseAccountTool } from "../mcp/tools";
import { setPermission } from "../permissions/store";

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
  connectionRoutes.post(`/connections/:id/${action}`, ownerOnly, readForm, async (c) => {
    const id = parseConnectionId(c.req.param("id"));
    if (!id) return c.json({ outcome: "not_found" }, 404);
    const owner = c.get("owner");
    const name = action === "name" ? parseName(c.get("form").get("name")) : null;
    if (action === "name" && !name) return c.json({ outcome: "invalid" }, 400);
    const result = await Effect.runPromise(
      Effect.result<
        string | { grantId: string },
        import("../db").WriteUncertain | import("../db").Unavailable,
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

connectionRoutes.post("/connections/:id/permissions", ownerOnly, readForm, async (c) => {
  const connectionId = parseConnectionId(c.req.param("id"));
  const form = c.get("form");
  const accountId = parseAccountId(form.get("account"));
  const tool = parseAccountTool(form.get("tool"));
  const allowed = form.get("allowed");
  if (!connectionId || !accountId) return c.json({ outcome: "not_found" }, 404);
  if (!tool || (allowed !== "true" && allowed !== "false"))
    return c.json({ outcome: "invalid" }, 400);
  const result = await Effect.runPromise(
    Effect.result(
      setPermission(
        c.env.DB,
        c.get("owner"),
        {
          connectionId,
          accountId,
          tool,
          allowed: allowed === "true",
        },
        Date.now(),
      ),
    ),
  );
  if (Result.isFailure(result)) return c.json({ outcome: "unknown" }, 503);
  return c.json({ outcome: result.success }, result.success === "not_found" ? 404 : 200);
});

connectionRoutes.get("/connections/:id", ownerOnly, async (c) => {
  const id = parseConnectionId(c.req.param("id"));
  if (!id) return c.notFound();
  const owner = c.get("owner");
  const now = Date.now();
  const result = await Effect.runPromise(
    Effect.result(
      Effect.gen(function* () {
        const snapshot = yield* Effect.tryPromise({
          try: async () => {
            const rows = await c.env.DB.batch([
              connectionsStatement(c.env.DB, owner, now),
              accountsStatement(c.env.DB, owner),
              permissionsStatement(c.env.DB, owner, id, now),
            ]);
            return {
              connections: decodeConnections(
                rows[0]!.results as Parameters<typeof decodeConnections>[0],
                now,
              ),
              accounts: await decodeAccounts(
                rows[1]!.results as Parameters<typeof decodeAccounts>[0],
                c.get("config").tokenKey,
              ),
              allowed: decodePermissions(
                rows[2]!.results as Parameters<typeof decodePermissions>[0],
              ),
            };
          },
          catch: () => new Unavailable(),
        });
        const connection = snapshot.connections.find((row) => row.id === id);
        if (!connection) return null;
        const active = connection.status.kind === "active";
        const accounts = active ? snapshot.accounts : [];
        const allowed = active ? snapshot.allowed : [];
        return { connection, accounts, allowed };
      }),
    ),
  );
  if (Result.isFailure(result)) return renderPage({ _tag: "Unavailable" }, { status: 503 });
  if (!result.success) return c.notFound();
  return renderPage({
    _tag: "Connection",
    ...result.success,
    frame: { host: new URL(c.req.url).host, ownerEmail: owner.email, current: "connections" },
    tools: TOOLS.filter((t) => t.kind === "account").map((t) => ({
      name: t.name,
      label: t.label,
      description: t.permissionDescription,
    })),
    requiredGmailScopes: GMAIL_SCOPES.length,
  });
});

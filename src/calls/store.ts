import { Effect } from "effect";
import { Unavailable } from "../db";
import { activeWhere } from "../connections/store";
import type { OwnerEmail } from "../owner/owner";
import type { CallContext } from "../mcp/call";
import type { Tool } from "../mcp/tools";
export type CallId = number & { readonly __callId: unique symbol };
export type Outcome = "success" | "refused" | "failed";

// Resolve the account in SQL and return only the record ID. Callers must not learn
// whether an unavailable address belongs to a hidden account. Never store agent text.
export const recordStatement = (
  ctx: CallContext,
  tool: Tool["name"] | null,
  account: OwnerEmail | null,
) =>
  ctx.db
    .prepare(`INSERT INTO calls (connection_id,account_id,tool,at)
    SELECT c.id, (SELECT a.id FROM accounts a WHERE a.email = ?2 AND a.state = 'live' AND a.generation = ?5), ?3, ?4
    FROM connections c WHERE c.id = ?1 AND c.generation = ?5 AND ${activeWhere({ now: "?4", ownerEmail: "?6" })} RETURNING id`)
    .bind(
      ctx.connection.connectionId,
      account,
      tool,
      ctx.now(),
      ctx.owner.generation,
      ctx.owner.email,
    );
export const decodeCallId = (result: D1Result): CallId | null => {
  const row = result.results[0];
  const id = row && typeof row === "object" && "id" in row ? row.id : null;
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? (id as CallId) : null;
};
export const closeCall = (ctx: CallContext, id: CallId, outcome: Outcome) =>
  Effect.tryPromise({
    // A reset can reuse a numeric call ID, but never a connection ID.
    try: async () => {
      await ctx.db
        .prepare("UPDATE calls SET outcome = ?1 WHERE id = ?2 AND connection_id = ?3")
        .bind(outcome, id, ctx.connection.connectionId)
        .run();
    },
    catch: () => new Unavailable(),
  });

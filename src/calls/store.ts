import { Effect } from "effect";
import { Unavailable } from "../db";
import { activeWhere } from "../connections/store";
import type { OwnerEmail } from "../owner/owner";
import type { CallContext } from "../mcp/call";
import type { Tool } from "../mcp/tools";
import type { FailureCode } from "../mcp/failures";
export type CallId = number & { readonly __callId: unique symbol };
export type Outcome =
  | "success"
  | "refused"
  | "failed"
  | "pending"
  | "rejected"
  | "expired"
  | "repeat";

// Resolve the account in SQL and return only the record ID. Callers must not learn
// whether an unavailable address belongs to a hidden account. Never store agent text.
export const recordStatement = (
  ctx: CallContext,
  tool: Tool["name"] | null,
  account: OwnerEmail | null,
  also: ReadonlyArray<{ account: OwnerEmail; tool: string }> = [],
) =>
  ctx.db
    .prepare(`INSERT INTO calls (connection_id,account_id,tool,at,also)
    SELECT c.id, (SELECT a.id FROM accounts a WHERE a.email = ?2 AND a.state = 'live' AND a.generation = ?5), ?3, ?4,
    (SELECT CASE WHEN count(*) > 0 THEN json_group_array(json_object('account',a.id,'tool',json_extract(u.value,'$.tool'))) ELSE NULL END
     FROM json_each(?7) u JOIN accounts a ON a.email = json_extract(u.value,'$.account') AND a.state = 'live' AND a.generation = ?5)
    FROM connections c WHERE c.id = ?1 AND c.generation = ?5 AND ${activeWhere({ now: "?4", ownerEmail: "?6" })} RETURNING id`)
    .bind(
      ctx.connection.connectionId,
      account,
      tool,
      ctx.now(),
      ctx.owner.generation,
      ctx.owner.email,
      JSON.stringify(also),
    );
export const decodeCallId = (result: D1Result): CallId | null => {
  const row = result.results[0];
  const id = row && typeof row === "object" && "id" in row ? row.id : null;
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? (id as CallId) : null;
};
export const closeCall = (
  ctx: CallContext,
  id: CallId,
  outcome: Outcome,
  reason: FailureCode | null,
) =>
  Effect.tryPromise({
    // A reset can reuse a numeric call ID, but never a connection ID.
    try: async () => {
      await ctx.db
        .prepare("UPDATE calls SET outcome = ?1, reason = ?4 WHERE id = ?2 AND connection_id = ?3")
        .bind(outcome, id, ctx.connection.connectionId, reason)
        .run();
    },
    catch: () => new Unavailable(),
  });

import { Effect } from "effect";
import { Unavailable, WriteUncertain } from "../db";
import type { Owner } from "../owner/owner";
import { allowedAccountColumns } from "../accounts/store";
import { activeWhere } from "../connections/store";
import { permittedWhere } from "../permissions/store";
import type { ConnectionId } from "../connections/model";
import type { CallContext } from "../mcp/call";
import type { CallId, Outcome } from "../calls/store";
import type { Sealed } from "../seal";
import { HOUR, type ApprovalId, type ApprovalRow, type SnapshotAccount, type Use } from "./model";

export interface ApprovalContext {
  db: D1Database;
  owner: Owner;
}
// All SQL expressions here are supplied by code. The approval table keeps its full name.
const ownerGuard = (generation: string, email: string) =>
  `approvals.generation = ${generation} AND EXISTS (SELECT 1 FROM owner o WHERE o.id = 1 AND o.state = 'pinned' AND o.generation = approvals.generation AND o.email = ${email})`;
const usable = (connection: string, generation: string, uses: string, now: string, email: string) =>
  `EXISTS (SELECT 1 FROM connections c WHERE c.id = ${connection} AND c.generation = ${generation} AND ${activeWhere({ now, ownerEmail: email })})
   AND NOT EXISTS (SELECT 1 FROM json_each(${uses}) u WHERE NOT EXISTS (
     SELECT 1 FROM accounts a WHERE a.id = json_extract(u.value, '$.account') AND a.generation = ${generation}
     AND ${permittedWhere({ connection, tool: "json_extract(u.value, '$.tool')", now, ownerEmail: email })}))`;
const rowUsable = (now: string, email: string) =>
  usable("approvals.connection_id", "approvals.generation", "approvals.uses", now, email);

export const createApproval = (
  ctx: CallContext,
  input: {
    id: ApprovalId;
    call: CallId;
    tool: Use["tool"];
    uses: readonly Use[];
    arguments: Sealed;
    at: number;
  },
) =>
  Effect.tryPromise({
    try: async () => {
      const { id, call, tool, at } = input;
      const results = await ctx.db.batch([
        ctx.db
          .prepare(`INSERT INTO approvals (id,generation,connection_id,call_id,tool,uses,created_at,expires_at,state,arguments)
          SELECT ?1,?2,?3,?4,?5,?6,?7,?8,'waiting',?9
          WHERE ${usable("?3", "?2", "?6", "?7", "?10")}
          AND (SELECT count(*) FROM approvals WHERE connection_id = ?3 AND generation = ?2 AND state = 'waiting' AND expires_at > ?7) < 20 RETURNING id`)
          .bind(
            id,
            ctx.owner.generation,
            ctx.connection.connectionId,
            call,
            tool,
            JSON.stringify(input.uses),
            at,
            at + HOUR,
            input.arguments,
            ctx.owner.email,
          ),
        ctx.db
          .prepare(`UPDATE calls SET outcome = 'pending' WHERE id = ?1 AND connection_id = ?2
          AND EXISTS (SELECT 1 FROM approvals WHERE approvals.id = ?3 AND approvals.call_id = calls.id AND approvals.connection_id = calls.connection_id AND ${ownerGuard("?4", "?5")})`)
          .bind(call, ctx.connection.connectionId, id, ctx.owner.generation, ctx.owner.email),
        ctx.db
          .prepare(
            `SELECT count(*) AS count FROM approvals WHERE connection_id = ?1 AND state = 'waiting' AND expires_at > ?2 AND ${ownerGuard("?3", "?4")}`,
          )
          .bind(ctx.connection.connectionId, at, ctx.owner.generation, ctx.owner.email),
      ]);
      return results[0]!.results.length
        ? ("created" as const)
        : Number((results[2]!.results[0] as { count: number }).count) >= 20
          ? ("limit" as const)
          : ("unavailable" as const);
    },
    catch: () => new WriteUncertain(),
  });

// Audit writes match both identifiers; a reset can reuse numeric call IDs.
const audit = (
  db: D1Database,
  where: string,
  outcome: string,
  values: (string | number | null)[],
  callGuard = "calls.outcome = 'pending'",
) =>
  db
    .prepare(`UPDATE calls SET outcome = ${outcome} WHERE ${callGuard}
    AND (calls.id, calls.connection_id) IN (SELECT call_id, connection_id FROM approvals WHERE ${where})`)
    .bind(...values);
const expireStatements = (
  db: D1Database,
  where: string,
  now: string,
  values: (string | number | null)[],
) => {
  const expired = `${where} AND state = 'waiting' AND expires_at <= ${now}`;
  return [
    audit(db, expired, "'expired'", values),
    db
      .prepare(`UPDATE approvals SET state = 'expired', arguments = NULL WHERE ${expired}`)
      .bind(...values),
  ];
};
const unknownStatement = (
  db: D1Database,
  where: string,
  now: string,
  values: (string | number | null)[],
) =>
  db
    .prepare(
      `UPDATE approvals SET outcome = 'unknown' WHERE ${where} AND state = 'approved' AND outcome IS NULL AND decided_at + 30000 <= ${now}`,
    )
    .bind(...values);
export const readApproval = (
  ctx: ApprovalContext,
  id: ApprovalId,
  now: number,
  connection?: ConnectionId,
) =>
  Effect.tryPromise({
    try: async () => {
      const where = `approvals.id = ?1 AND ${ownerGuard("?2", "?3")} AND (?5 IS NULL OR connection_id = ?5)`;
      const values = [id, ctx.owner.generation, ctx.owner.email, now, connection ?? null];
      const batch = await ctx.db.batch([
        ...expireStatements(ctx.db, where, "?4", values),
        unknownStatement(ctx.db, where, "?4", values),
        ctx.db
          .prepare(`SELECT approvals.id, approvals.generation, connection_id, call_id, tool, uses, created_at, expires_at, state, ended_by, decided_at, outcome, arguments, purged,
          CASE WHEN purged = 0 AND decided_at + ${HOUR} > ?4 AND ${rowUsable("?4", "?3")} THEN result ELSE NULL END AS result,
          CASE WHEN purged = 0 AND decided_at + ${HOUR} > ?4 AND ${rowUsable("?4", "?3")} THEN result_too_large ELSE 0 END AS result_too_large,
          (SELECT name FROM connections WHERE id = approvals.connection_id AND generation = approvals.generation) AS connection_name,
          (SELECT app FROM connections WHERE id = approvals.connection_id AND generation = approvals.generation) AS app,
          (SELECT json_group_array(json_object('id',a.id,'name',a.name,'email',a.email,'hd',a.hd,'version',a.version)) FROM json_each(approvals.uses) u
           JOIN accounts a ON a.id = json_extract(u.value,'$.account') AND a.generation = approvals.generation) AS accounts
          FROM approvals WHERE ${where}`)
          .bind(...values),
      ]);
      return (batch.at(-1)!.results[0] as unknown as ApprovalRow | undefined) ?? null;
    },
    catch: () => new WriteUncertain(),
  });

export interface Decision {
  id: ApprovalId;
  at: number;
  claim: string;
  action: "approve" | "reject";
  snapshot?: { connection: string; accounts: readonly SnapshotAccount[] };
}
export const decisionStatement = (ctx: ApprovalContext, input: Decision) => {
  const snapshot =
    input.action === "approve"
      ? `AND EXISTS (SELECT 1 FROM connections c WHERE c.id = approvals.connection_id AND c.name = ?6)
    AND NOT EXISTS (SELECT 1 FROM json_each(approvals.uses) u WHERE NOT EXISTS (SELECT 1 FROM accounts a JOIN json_each(?7) s ON a.id = json_extract(s.value,'$.id')
      WHERE a.id = json_extract(u.value,'$.account') AND a.name = json_extract(s.value,'$.name') AND a.email = json_extract(s.value,'$.email') AND a.version = json_extract(s.value,'$.version')))`
      : "";
  return ctx.db
    .prepare(`UPDATE approvals SET state = '${input.action === "approve" ? "approved" : "rejected"}', decided_at = ?4, arguments = NULL, claim = ?5
    WHERE id = ?1 AND ${ownerGuard("?2", "?3")} AND state = 'waiting' AND ?4 < expires_at AND ${rowUsable("?4", "?3")} ${snapshot} RETURNING id`)
    .bind(
      input.id,
      ctx.owner.generation,
      ctx.owner.email,
      input.at,
      input.claim,
      ...(input.action === "approve"
        ? [input.snapshot!.connection, JSON.stringify(input.snapshot!.accounts)]
        : []),
    );
};
export const decideApproval = (ctx: ApprovalContext, input: Decision) =>
  Effect.tryPromise({
    try: async () => {
      const where = `approvals.id = ?1 AND ${ownerGuard("?2", "?3")} AND claim = ?4 AND decided_at = ?5 AND approvals.state = ?6`;
      const values = [
        input.id,
        ctx.owner.generation,
        ctx.owner.email,
        input.claim,
        input.at,
        input.action === "approve" ? "approved" : "rejected",
      ];
      const batch = await ctx.db.batch([
        decisionStatement(ctx, input),
        audit(ctx.db, where, input.action === "approve" ? "NULL" : "'rejected'", values),
        ctx.db
          .prepare(`SELECT ${allowedAccountColumns}
        FROM approvals JOIN json_each(approvals.uses) u JOIN accounts a ON a.id = json_extract(u.value,'$.account') AND a.generation = approvals.generation
        WHERE ${where} AND approvals.state = 'approved'`)
          .bind(...values),
      ]);
      return { won: batch[0]!.results.length > 0, credentials: batch[2]!.results };
    },
    catch: () => new WriteUncertain(),
  });
export const finishApproval = (
  ctx: ApprovalContext,
  decision: Pick<Decision, "id" | "at" | "claim">,
  now: number,
  outcome: "success" | "failed" | "unknown",
  auditOutcome: Outcome | null,
  result: Sealed | null,
  tooLarge: boolean,
) =>
  Effect.tryPromise({
    try: () =>
      ctx.db.batch([
        ctx.db
          .prepare(`UPDATE approvals SET outcome = ?5,
      result = CASE WHEN purged = 0 AND ${rowUsable("?4", "?3")} THEN ?6 ELSE NULL END,
      result_too_large = CASE WHEN purged = 0 AND ${rowUsable("?4", "?3")} THEN ?7 ELSE 0 END
      WHERE id = ?1 AND ${ownerGuard("?2", "?3")} AND state = 'approved' AND outcome IS NULL AND ?4 < decided_at + 30000 AND claim = ?8 AND decided_at = ?9`)
          .bind(
            decision.id,
            ctx.owner.generation,
            ctx.owner.email,
            now,
            outcome,
            result,
            Number(tooLarge),
            decision.claim,
            decision.at,
          ),
        audit(
          ctx.db,
          `approvals.id = ?1 AND ${ownerGuard("?2", "?3")} AND approvals.state = 'approved' AND approvals.outcome = ?5 AND claim = ?6 AND decided_at = ?7`,
          "?4",
          [
            decision.id,
            ctx.owner.generation,
            ctx.owner.email,
            auditOutcome,
            outcome,
            decision.claim,
            decision.at,
          ],
          "calls.outcome IS NULL",
        ),
      ]),
    catch: () => new WriteUncertain(),
  });

/** Prepend to the owner's change, using its guard and bindings before it changes that guard. */
export const purgeApprovals = (
  db: D1Database,
  input: {
    where: string;
    guard: string;
    generation: string;
    email: string;
    now: string;
    by: "tool" | "connection" | "account";
    values: (string | number | null)[];
  },
) => {
  const where = `(${input.where}) AND (${input.guard}) AND ${ownerGuard(input.generation, input.email)}`;
  const waiting = `${where} AND state = 'waiting' AND expires_at > ${input.now}`;
  return [
    ...expireStatements(db, where, input.now, input.values),
    audit(db, waiting, "'refused'", input.values),
    db
      .prepare(
        `UPDATE approvals SET state = 'refused', ended_by = '${input.by}', arguments = NULL WHERE ${waiting}`,
      )
      .bind(...input.values),
    db
      .prepare(
        `UPDATE approvals SET arguments = NULL, result = NULL, purged = 1 WHERE ${where} AND purged = 0`,
      )
      .bind(...input.values),
  ];
};
export const cleanupApprovals = (ctx: ApprovalContext, now: number) =>
  Effect.tryPromise({
    try: () => {
      const where = ownerGuard("?1", "?2");
      const values = [ctx.owner.generation, ctx.owner.email, now];
      return ctx.db.batch([
        ...expireStatements(ctx.db, where, "?3", values),
        unknownStatement(ctx.db, where, "?3", values),
        ctx.db
          .prepare(
            `UPDATE approvals SET result = NULL WHERE ${where} AND result IS NOT NULL AND decided_at <= ?3 - ${HOUR}`,
          )
          .bind(...values),
      ]);
    },
    catch: () => new Unavailable(),
  });

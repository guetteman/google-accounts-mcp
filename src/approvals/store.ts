import {
  usableUploadsWhere,
  deleteApprovalUploadsStatement,
  missingUploadStatement,
  type UploadId,
} from "../uploads/store";
import { Effect, Schema } from "effect";
import { Unavailable, WriteUncertain } from "../db";
import type { Owner } from "../owner/owner";
import { allowedAccountColumns } from "../accounts/store";
import { activeWhere } from "../connections/store";
import { permittedWhere } from "../permissions/store";
import type { ConnectionId } from "../connections/model";
import type { CallContext } from "../mcp/call";
import type { CallId, Outcome } from "../calls/store";
import type { FailureCode } from "../mcp/failures";
import type { Sealed } from "../seal";
import {
  APPROVAL_LIFETIME,
  RESULT_LIFETIME,
  OUTCOME_WINDOW,
  WAITING_LIMIT,
  parseApprovalId,
  type ApprovalId,
  type Approval,
  type Target,
  type Won,
  type Use,
} from "./model";
import { parseAccountId } from "../accounts/model";
import { ToolFailure } from "../mcp/failures";
import { parseAccountTool } from "../mcp/tools";
import { parseConnectionId } from "../connections/model";
import type { Identity } from "../once/identity";
import { liveRowWhere, rowStatement, decodeRow, type Repeat } from "../once/store";

const won = Symbol("Won");
export type WonBrand = { readonly [won]: true };
const ApprovalRow = Schema.Struct({
  id: Schema.String,
  connection_id: Schema.String,
  call_id: Schema.Int,
  tool: Schema.String,
  uses: Schema.String,
  created_at: Schema.Int,
  expires_at: Schema.Int,
  state: Schema.Literals(["waiting", "approved", "rejected", "expired", "refused"]),
  ended_by: Schema.NullOr(Schema.Literals(["tool", "connection", "account"])),
  decided_at: Schema.NullOr(Schema.Int),
  outcome: Schema.NullOr(Schema.Literals(["success", "failed", "unknown"])),
  arguments: Schema.NullOr(Schema.String),
  result: Schema.NullOr(Schema.String),
  connection_name: Schema.String,
  app: Schema.Literals(["claude-code", "claude-hosted", "chatgpt"]),
  accounts: Schema.String,
});
const Uses = Schema.Array(Schema.Struct({ account: Schema.String, tool: Schema.String }));
const Accounts = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    email: Schema.String,
    hd: Schema.NullOr(Schema.String),
  }),
);
function decodeApproval(raw: unknown): Approval {
  const row = Schema.decodeUnknownSync(ApprovalRow)(raw);
  const id = parseApprovalId(row.id);
  const connection = parseConnectionId(row.connection_id);
  const tool = parseAccountTool(row.tool);
  if (!id || !connection || !tool) throw new WriteUncertain();
  const uses = Schema.decodeUnknownSync(Uses)(JSON.parse(row.uses)).map((use) => {
    const account = parseAccountId(use.account);
    const tool = parseAccountTool(use.tool);
    if (!account || !tool) throw new WriteUncertain();
    return { account, tool };
  });
  const accounts = Schema.decodeUnknownSync(Accounts)(JSON.parse(row.accounts)).map((account) => {
    const id = parseAccountId(account.id);
    if (!id) throw new WriteUncertain();
    return { ...account, id };
  });
  const common = {
    id,
    connection: { id: connection, name: row.connection_name, app: row.app },
    accounts,
    uses,
    tool,
    call: row.call_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
  switch (row.state) {
    case "waiting":
      if (row.arguments !== null)
        return { ...common, state: "waiting", arguments: row.arguments as Sealed };
      break;
    case "approved":
      if (row.decided_at !== null)
        return row.outcome === null
          ? { ...common, state: "running", decidedAt: row.decided_at }
          : {
              ...common,
              state: "finished",
              decidedAt: row.decided_at,
              outcome: row.outcome,
              result: row.result as Sealed | null,
            };
      break;
    case "rejected":
      if (row.decided_at !== null)
        return { ...common, state: "rejected", decidedAt: row.decided_at };
      break;
    case "expired":
      return { ...common, state: "expired" };
    case "refused":
      if (row.ended_by !== null) return { ...common, state: "refused", endedBy: row.ended_by };
  }
  throw new WriteUncertain();
}

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

/** Guard every tool with create against the owner's current settings before creating or sending. */
export const stillApproved = (ctx: ApprovalContext, won: Won): Effect.Effect<void, ToolFailure> =>
  Effect.tryPromise({
    try: () =>
      ctx.db
        .prepare(`SELECT 1 FROM approvals WHERE approvals.id = ?1
      AND ${ownerGuard("?2", "?3")} AND state = 'approved' AND claim = ?4 AND decided_at = ?5
      AND ${rowUsable("?6", "?3")}`)
        .bind(won.id, ctx.owner.generation, ctx.owner.email, won.claim, won.at, Date.now())
        .first(),
    catch: () => new ToolFailure({ code: "server_unavailable" }),
  }).pipe(
    Effect.flatMap((row) =>
      row ? Effect.void : Effect.fail(new ToolFailure({ code: "tool_not_allowed" })),
    ),
  );

const waitingStatement = (
  ctx: Pick<CallContext, "db" | "owner" | "connection">,
  identity: Identity,
  now: number,
) =>
  ctx.db
    .prepare(`SELECT id, expires_at FROM approvals WHERE connection_id = ?1 AND identity = ?2
            AND state = 'waiting' AND expires_at > ?3 AND ${ownerGuard("?4", "?5")}`)
    .bind(ctx.connection.connectionId, identity, now, ctx.owner.generation, ctx.owner.email);
const decodeWaiting = (raw: unknown): { id: ApprovalId; expiresAt: number } | null => {
  if (raw === undefined || raw === null) return null;
  const row = Schema.decodeUnknownSync(
    Schema.Struct({ id: Schema.String, expires_at: Schema.Int }),
  )(raw);
  const id = parseApprovalId(row.id);
  if (!id) throw new WriteUncertain();
  return { id, expiresAt: row.expires_at };
};
export const waitingApproval = (
  ctx: Pick<CallContext, "db" | "owner" | "connection">,
  identity: Identity,
  now: number,
): Effect.Effect<{ id: ApprovalId; expiresAt: number } | null, Unavailable> =>
  Effect.tryPromise({
    try: async () => decodeWaiting(await waitingStatement(ctx, identity, now).first<unknown>()),
    catch: () => new Unavailable(),
  });

export const createApproval = (
  ctx: CallContext,
  input: {
    id: ApprovalId;
    call: CallId;
    tool: Use["tool"];
    uses: readonly Use[];
    arguments: Sealed;
    at: number;
    identity?: Identity;
    uploads?: { ids: readonly UploadId[]; found: boolean };
  },
): Effect.Effect<
  | "created"
  | "limit"
  | "unavailable"
  | { upload: UploadId }
  | { waiting: { id: ApprovalId; expiresAt: number } }
  | { repeat: Repeat },
  WriteUncertain
> =>
  Effect.tryPromise({
    try: async () => {
      const { id, call, tool, at } = input;
      const results = await ctx.db.batch([
        ctx.db
          .prepare(`INSERT INTO approvals (id,generation,connection_id,call_id,tool,uses,created_at,expires_at,state,arguments,identity)
          SELECT ?1,?2,?3,?4,?5,?6,?7,?8,'waiting',?9,?11
          WHERE ${usable("?3", "?2", "?6", "?7", "?10")}
          AND (?13 = 1 AND ${usableUploadsWhere({ ids: "?12", count: "json_array_length(?12)", connection: "?3", generation: "?2", now: "?14", email: "?10", identity: "?11" })})
          AND (?11 IS NULL OR (NOT ${liveRowWhere("?11", "?7")}
            AND NOT EXISTS (SELECT 1 FROM approvals WHERE connection_id = ?3 AND identity = ?11 AND state = 'waiting' AND expires_at > ?7)))
          AND (SELECT count(*) FROM approvals WHERE connection_id = ?3 AND generation = ?2 AND state = 'waiting' AND expires_at > ?7) < ${WAITING_LIMIT} RETURNING id`)
          .bind(
            id,
            ctx.owner.generation,
            ctx.connection.connectionId,
            call,
            tool,
            JSON.stringify(input.uses),
            at,
            at + APPROVAL_LIFETIME,
            input.arguments,
            ctx.owner.email,
            input.identity ?? null,
            JSON.stringify(input.uploads?.ids ?? []),
            input.uploads?.found === false ? 0 : 1,
            ctx.now(),
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
        ...(input.identity
          ? [rowStatement(ctx.db, input.identity), waitingStatement(ctx, input.identity, at)]
          : []),
        ...(input.uploads?.ids.length
          ? [
              missingUploadStatement(ctx, input.uploads.ids, input.identity ?? null),
              deleteApprovalUploadsStatement(ctx, input.uploads.ids, id),
            ]
          : []),
      ]);
      if (results[0]!.results.length) return "created";
      if (input.identity) {
        const repeat = decodeRow(results[3]!, at);
        if (repeat) return { repeat };
        const waiting = decodeWaiting(results[4]!.results[0]);
        if (waiting) return { waiting };
      }
      if (input.uploads?.ids.length) {
        const missing = results[input.identity ? 5 : 3]!.results[0] as { id: UploadId } | undefined;
        if (missing) return { upload: missing.id };
      }
      return Number((results[2]!.results[0] as { count: number }).count) >= WAITING_LIMIT
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
  reason?: string,
) =>
  db
    .prepare(`UPDATE calls SET outcome = ${outcome}${reason ? `, reason = ${reason}` : ""} WHERE ${callGuard}
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
      `UPDATE approvals SET outcome = 'unknown' WHERE ${where} AND state = 'approved' AND outcome IS NULL AND decided_at + ${OUTCOME_WINDOW} <= ${now}`,
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
          .prepare(`SELECT approvals.id, approvals.generation, connection_id, call_id, tool, uses, created_at, expires_at, state, ended_by, decided_at, outcome, arguments,
          CASE WHEN decided_at + ${RESULT_LIFETIME} > ?4 AND ${rowUsable("?4", "?3")} THEN result ELSE NULL END AS result,
          (SELECT name FROM connections WHERE id = approvals.connection_id AND generation = approvals.generation) AS connection_name,
          (SELECT app FROM connections WHERE id = approvals.connection_id AND generation = approvals.generation) AS app,
          (SELECT json_group_array(json_object('id',a.id,'name',a.name,'email',a.email,'hd',a.hd)) FROM json_each(approvals.uses) u
           JOIN accounts a ON a.id = json_extract(u.value,'$.account') AND a.generation = approvals.generation) AS accounts
          FROM approvals WHERE ${where}`)
          .bind(...values),
      ]);
      const raw = batch.at(-1)!.results[0];
      return raw === undefined ? null : decodeApproval(raw);
    },
    catch: () => new WriteUncertain(),
  });

/** A view acquires a credential only while this waiting approval is still usable. */
export const viewCredential = (
  ctx: ApprovalContext,
  id: ApprovalId,
  now: number,
): Effect.Effect<ReadonlyArray<unknown>, Unavailable> =>
  Effect.tryPromise({
    try: () =>
      ctx.db
        .prepare(`SELECT ${allowedAccountColumns}
      FROM approvals JOIN json_each(approvals.uses) u JOIN accounts a ON a.id = json_extract(u.value,'$.account') AND a.generation = approvals.generation
      WHERE approvals.id = ?1 AND ${ownerGuard("?2", "?3")} AND approvals.state = 'waiting' AND ?4 < approvals.expires_at AND ${rowUsable("?4", "?3")}`)
        .bind(id, ctx.owner.generation, ctx.owner.email, now)
        .all<unknown>()
        .then((result) => result.results),
    catch: () => new Unavailable(),
  });

export interface Decision {
  id: ApprovalId;
  at: number;
  claim: string;
  action: "approve" | "reject";
}
export const decisionStatement = (ctx: ApprovalContext, input: Decision) => {
  return ctx.db
    .prepare(`UPDATE approvals SET state = '${input.action === "approve" ? "approved" : "rejected"}', decided_at = ?4, arguments = NULL, claim = ?5
    WHERE id = ?1 AND ${ownerGuard("?2", "?3")} AND state = 'waiting' AND ?4 < expires_at AND ${rowUsable("?4", "?3")} RETURNING id`)
    .bind(input.id, ctx.owner.generation, ctx.owner.email, input.at, input.claim);
};
export const decideApproval = (ctx: ApprovalContext, decision: Omit<Decision, "claim">) =>
  Effect.tryPromise({
    try: async () => {
      const input = { ...decision, claim: crypto.randomUUID() };
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
      return batch[0]!.results.length > 0
        ? {
            won: { id: input.id, at: input.at, claim: input.claim, [won]: true } satisfies Won,
            credentials: batch[2]!.results,
          }
        : { won: null };
    },
    catch: () => new WriteUncertain(),
  });
export const finishApproval = (
  ctx: ApprovalContext,
  decision: Won,
  now: number,
  outcome: "success" | "failed" | "unknown",
  auditOutcome: Outcome | null,
  reason: FailureCode | null,
  result: Sealed | null,
) =>
  Effect.tryPromise({
    try: () =>
      ctx.db.batch([
        ctx.db
          .prepare(`UPDATE approvals SET outcome = ?5,
      result = CASE WHEN ${rowUsable("?4", "?3")} THEN ?6 ELSE NULL END
      WHERE id = ?1 AND ${ownerGuard("?2", "?3")} AND state = 'approved' AND outcome IS NULL AND ?4 < decided_at + ${OUTCOME_WINDOW} AND claim = ?7 AND decided_at = ?8`)
          .bind(
            decision.id,
            ctx.owner.generation,
            ctx.owner.email,
            now,
            outcome,
            result,
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
            reason,
          ],
          "calls.outcome IS NULL",
          "?8",
        ),
      ]),
    catch: () => new WriteUncertain(),
  }).pipe(Effect.asVoid);

type GuardCommon = { generation: string; ownerEmail: string; now: string };
/** Placeholder expressions are supplied by stores, never by request data. */
export function changeGuard(
  ...[kind, p]:
    | ["connection", GuardCommon & { connection: string }]
    | ["account", GuardCommon & { account: string }]
    | ["tool", GuardCommon & { connection: string; account: string }]
): string {
  switch (kind) {
    case "connection":
      return `EXISTS (SELECT 1 FROM connections c WHERE c.id = ${p.connection} AND c.generation = ${p.generation} AND ${activeWhere(p)})`;
    case "account":
      return `EXISTS (SELECT 1 FROM accounts a WHERE a.id = ${p.account} AND a.state = 'live' AND a.generation = ${p.generation} AND EXISTS (SELECT 1 FROM owner o WHERE o.id = 1 AND o.state = 'pinned' AND o.generation = a.generation AND o.email = ${p.ownerEmail}))`;
    case "tool":
      return `EXISTS (SELECT 1 FROM accounts a JOIN connections c ON c.id = ${p.connection} WHERE a.id = ${p.account} AND a.state = 'live' AND a.generation = ${p.generation} AND c.generation = ${p.generation} AND ${activeWhere(p)})`;
  }
}
/** Prepend to the owner's change; every statement binds its own values. */
export const endApprovals = (db: D1Database, owner: Owner, target: Target, now: number) => {
  const common = { generation: "?1", ownerEmail: "?2", now: "?3" };
  const values: (string | number)[] = [owner.generation, owner.email, now];
  let scope: string;
  let guard: string;
  let by: "tool" | "connection" | "account";
  if ("tool" in target) {
    by = "tool";
    values.push(target.connection, target.account, target.tool);
    guard = changeGuard(by, { ...common, connection: "?4", account: "?5" });
    scope =
      "approvals.connection_id = ?4 AND EXISTS (SELECT 1 FROM json_each(approvals.uses) u WHERE json_extract(u.value,'$.account') = ?5 AND json_extract(u.value,'$.tool') = ?6)";
  } else if ("connection" in target) {
    by = "connection";
    values.push(target.connection);
    guard = changeGuard(by, { ...common, connection: "?4" });
    scope = "approvals.connection_id = ?4";
  } else {
    by = "account";
    values.push(target.account);
    guard = changeGuard(by, { ...common, account: "?4" });
    scope =
      "EXISTS (SELECT 1 FROM json_each(approvals.uses) u WHERE json_extract(u.value,'$.account') = ?4)";
  }
  const where = `(${scope}) AND (${guard}) AND ${ownerGuard("?1", "?2")}`;
  const waiting = `${where} AND state = 'waiting' AND expires_at > ?3`;
  return [
    ...expireStatements(db, where, "?3", values),
    audit(db, waiting, "'refused'", values),
    db
      .prepare(
        `UPDATE approvals SET state = 'refused', ended_by = '${by}', arguments = NULL WHERE ${waiting}`,
      )
      .bind(...values),
    db
      .prepare(
        `UPDATE approvals SET arguments = NULL, result = NULL WHERE ${where} AND (arguments IS NOT NULL OR result IS NOT NULL)`,
      )
      .bind(...values),
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
            `UPDATE approvals SET result = NULL WHERE ${where} AND result IS NOT NULL AND decided_at <= ?3 - ${RESULT_LIFETIME}`,
          )
          .bind(...values),
      ]);
    },
    catch: () => new Unavailable(),
  });

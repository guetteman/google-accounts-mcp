import { Effect, Schema } from "effect";
import { CALL_DEADLINE, RUN_DEADLINE } from "../approvals/model";
import { Unavailable, WriteUncertain } from "../db";
import type { Identity } from "./identity";

export const WINDOW = 7 * 24 * 3_600_000;
export const STALE = Math.max(CALL_DEADLINE, RUN_DEADLINE) + 5_000;
export type Created = { draft?: string; message: string; thread: string };
export type Claim = {
  readonly identity: Identity;
  readonly value: string;
  readonly __claim: unique symbol;
};
export type Repeat =
  | { kind: "done"; result: Created; at: number }
  | { kind: "running" }
  | { kind: "unknown"; until: number };
export type Entered = { kind: "run"; claim: Claim } | Repeat;
type OnceContext = { db: D1Database };
const Row = Schema.Struct({
  state: Schema.Literals(["running", "done", "unknown"]),
  taken_at: Schema.Int,
  expires_at: Schema.Int,
  draft_id: Schema.NullOr(Schema.String),
  message_id: Schema.NullOr(Schema.String),
  thread_id: Schema.NullOr(Schema.String),
});
/** Decode the row selected in either a take or an approval's atomic batch. */
const decodeRepeat = (raw: unknown, now: number): Repeat | null => {
  if (raw === undefined) return null;
  const row = Schema.decodeUnknownSync(Row)(raw);
  if (row.expires_at <= now) return null;
  if (row.state === "done") {
    if (row.message_id === null || row.thread_id === null) throw new WriteUncertain();
    return {
      kind: "done",
      at: row.taken_at,
      result: {
        ...(row.draft_id === null ? {} : { draft: row.draft_id }),
        message: row.message_id,
        thread: row.thread_id,
      },
    };
  }
  return row.state === "running" && row.taken_at + STALE > now
    ? { kind: "running" }
    : { kind: "unknown", until: row.expires_at };
};
export const decodeRow = (result: D1Result, now: number): Repeat | null =>
  decodeRepeat(result.results[0], now);
/** Placeholders are supplied by code, never by a request. */
export const liveRowWhere = (identity: string, now: string) =>
  `EXISTS (SELECT 1 FROM once WHERE identity = ${identity} AND expires_at > ${now})`;
export const rowStatement = (db: D1Database, identity: Identity) =>
  db.prepare("SELECT * FROM once WHERE identity = ?1").bind(identity);
export const cleanupStatement = (db: D1Database, now: number) =>
  db.prepare("DELETE FROM once WHERE expires_at <= ?1").bind(now);

export const take = (
  ctx: OnceContext,
  identity: Identity,
  now: number,
): Effect.Effect<Entered, WriteUncertain> =>
  Effect.tryPromise({
    try: async (): Promise<Entered> => {
      const value = crypto.randomUUID();
      const results = await ctx.db.batch([
        ctx.db
          .prepare("DELETE FROM once WHERE identity = ?1 AND expires_at <= ?2")
          .bind(identity, now),
        ctx.db
          .prepare(`INSERT INTO once (identity,state,claim,taken_at,expires_at)
          VALUES (?1,'running',?2,?3,?4) ON CONFLICT DO NOTHING RETURNING identity`)
          .bind(identity, value, now, now + WINDOW),
        rowStatement(ctx.db, identity),
      ]);
      if (results[1]!.results.length) return { kind: "run", claim: { identity, value } as Claim };
      const repeat = decodeRepeat(results[2]!.results[0], now);
      if (!repeat) throw new WriteUncertain();
      return repeat;
    },
    catch: () => new WriteUncertain(),
  });
export const settle = (
  ctx: OnceContext,
  claim: Claim,
  now: number,
  outcome: { kind: "done"; result: Created } | { kind: "unknown" },
): Effect.Effect<void, Unavailable> =>
  Effect.tryPromise({
    try: async () => {
      if (outcome.kind === "done")
        await ctx.db
          .prepare(`UPDATE once SET state = 'done', draft_id = ?3, message_id = ?4, thread_id = ?5, expires_at = ?6
          WHERE identity = ?1 AND claim = ?2 AND state IN ('running','unknown')`)
          .bind(
            claim.identity,
            claim.value,
            outcome.result.draft ?? null,
            outcome.result.message,
            outcome.result.thread,
            now + WINDOW,
          )
          .run();
      else
        await ctx.db
          .prepare(`UPDATE once SET state = 'unknown', expires_at = ?3
          WHERE identity = ?1 AND claim = ?2 AND state = 'running'`)
          .bind(claim.identity, claim.value, now + WINDOW)
          .run();
    },
    catch: () => new Unavailable(),
  });
export const release = (ctx: OnceContext, claim: Claim): Effect.Effect<void, Unavailable> =>
  Effect.tryPromise({
    try: async () => {
      await ctx.db
        .prepare("DELETE FROM once WHERE identity = ?1 AND claim = ?2")
        .bind(claim.identity, claim.value)
        .run();
    },
    catch: () => new Unavailable(),
  });

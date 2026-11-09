import { Data, Effect, Schema } from "effect";
import type { Config } from "../config";
import { batch, first, Unavailable } from "../db";
import { expiredSessionCleanup, newSession } from "./session";

export type OwnerEmail = string & { readonly __ownerEmail: unique symbol };
export function normalizeEmail(raw: unknown): OwnerEmail | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? (email as OwnerEmail) : null;
}

export const GenerationSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).pipe(
  Schema.brand("Generation"),
);
export type Generation = typeof GenerationSchema.Type;
const StoredOwner = Schema.Struct({
  state: Schema.Literals(["unpinned", "pinned", "resetting"]),
  generation: GenerationSchema,
  email: Schema.NullOr(Schema.String),
  google_sub: Schema.NullOr(Schema.String),
});
export interface OwnerRow {
  readonly state: "unpinned" | "pinned" | "resetting";
  readonly generation: Generation;
  readonly email: OwnerEmail | null;
  readonly googleSub: string | null;
}
export interface OwnerIdentity {
  readonly email: OwnerEmail;
  readonly googleSub: string;
}
export class NotOwner extends Data.TaggedError("NotOwner")<{ readonly email?: string }> {}
export class StaleFlow extends Data.TaggedError("StaleFlow") {}
export type Standing =
  | { readonly _tag: "Open"; readonly row: OwnerRow }
  | { readonly _tag: "Locked"; readonly reason: "mismatch" | "resetting" };

export const readOwner = (db: D1Database) =>
  Effect.gen(function* () {
    const raw = yield* first<unknown>(
      db,
      "SELECT state, generation, email, google_sub FROM owner WHERE id = 1",
    );
    const row = yield* Schema.decodeUnknownEffect(StoredOwner)(raw).pipe(
      Effect.mapError(() => new Unavailable()),
    );
    const email = normalizeEmail(row.email);
    if (
      (row.email !== null && email === null) ||
      (row.state === "pinned" && (!email || !row.google_sub)) ||
      (row.state === "unpinned" && (row.email !== null || row.google_sub !== null))
    ) {
      return yield* Effect.fail(new Unavailable());
    }
    return {
      state: row.state,
      generation: row.generation,
      email,
      googleSub: row.google_sub,
    } satisfies OwnerRow;
  });

export function standing(row: OwnerRow, config: Config): Standing {
  if (row.state === "resetting") return { _tag: "Locked", reason: "resetting" };
  if (row.state === "pinned" && row.email !== config.ownerEmail)
    return { _tag: "Locked", reason: "mismatch" };
  return { _tag: "Open", row };
}

export const signIn = (
  db: D1Database,
  config: Config,
  who: OwnerIdentity,
  flowGeneration: Generation,
  now: number,
) =>
  Effect.gen(function* () {
    const current = yield* readOwner(db);
    if (current.state === "pinned" && current.googleSub !== who.googleSub)
      return yield* Effect.fail(new NotOwner({ email: who.email }));
    const { token, tokenHash } = yield* newSession();
    const results = yield* batch(db, () => [
      db
        .prepare(`UPDATE owner SET state = 'pinned', email = ?, google_sub = ?
        WHERE id = 1 AND state = 'unpinned' AND generation = ?`)
        .bind(who.email, who.googleSub, flowGeneration),
      db
        .prepare(`INSERT INTO owner_sessions (token_hash, generation, created_at, last_used_at)
        SELECT ?, generation, ?, ? FROM owner WHERE id = 1 AND state = 'pinned'
        AND generation = ? AND google_sub = ? AND email = ? RETURNING token_hash`)
        .bind(tokenHash, now, now, flowGeneration, who.googleSub, config.ownerEmail),
      expiredSessionCleanup(db, tokenHash, now),
    ]);
    if (results[1]?.results.length) return token;
    const row = yield* readOwner(db);
    if (row.state === "pinned" && row.googleSub !== who.googleSub)
      return yield* Effect.fail(new NotOwner({ email: who.email }));
    return yield* Effect.fail(new StaleFlow());
  });

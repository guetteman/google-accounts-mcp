import { Data, Effect, Schema } from "effect";
import type { Config } from "../config";
import { first, Unavailable } from "../db";
import { verifyAccess } from "./access";

export type OwnerEmail = string & { readonly __ownerEmail: unique symbol };
export function normalizeEmail(raw: unknown): OwnerEmail | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? (email as OwnerEmail) : null;
}

export const GenerationSchema = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
).pipe(Schema.brand("Generation"));
export type Generation = typeof GenerationSchema.Type;
const StoredOwner = Schema.Struct({
  state: Schema.Literals(["unpinned", "pinned", "resetting"]),
  generation: GenerationSchema,
  email: Schema.NullOr(Schema.String),
});
export interface OwnerRow {
  readonly state: "unpinned" | "pinned" | "resetting";
  readonly generation: Generation;
  readonly email: OwnerEmail | null;
}
export interface Owner {
  readonly generation: Generation;
  readonly email: OwnerEmail;
}
export class NotOwner extends Data.TaggedError("NotOwner")<{ readonly email: string }> {}
export class Locked extends Data.TaggedError("Locked") {}

export const readOwner = (db: D1Database) =>
  Effect.gen(function* () {
    const raw = yield* first<unknown>(
      db,
      "SELECT state, generation, email FROM owner WHERE id = 1",
    );
    const row = yield* Schema.decodeUnknownEffect(StoredOwner)(raw).pipe(
      Effect.mapError(() => new Unavailable()),
    );
    const email = normalizeEmail(row.email);
    if (
      row.email !== email ||
      (row.state === "pinned" && email === null) ||
      (row.state === "unpinned" && email !== null)
    )
      return yield* Effect.fail(new Unavailable());
    return { ...row, email } satisfies OwnerRow;
  });

/** During a reset, or while OWNER_EMAIL differs from the pinned owner, nothing runs. */
export function isLocked(row: OwnerRow, config: Config): boolean {
  return row.state === "resetting" || (row.state === "pinned" && row.email !== config.ownerEmail);
}

export const pinOwner = (db: D1Database, email: OwnerEmail, observedGeneration: Generation) =>
  Effect.gen(function* () {
    const row = yield* first<{ generation: unknown }>(
      db,
      `UPDATE owner SET state = 'pinned', email = ?1
      WHERE id = 1 AND generation = ?2
        AND (state = 'unpinned' OR (state = 'pinned' AND email = ?1)) RETURNING generation`,
      [email, observedGeneration],
    );
    if (!row) return yield* Effect.fail(new Locked());
    return yield* Schema.decodeUnknownEffect(GenerationSchema)(row.generation).pipe(
      Effect.mapError(() => new Unavailable()),
    );
  });

export const requireOwner = (
  db: D1Database,
  config: Config,
  observedGeneration: Generation,
  request: Request,
  now: number,
) =>
  Effect.gen(function* () {
    const identity = yield* verifyAccess(request, config.access, now);
    if (identity.email !== config.ownerEmail)
      return yield* Effect.fail(new NotOwner({ email: identity.email }));
    const generation = yield* pinOwner(db, config.ownerEmail, observedGeneration);
    return { generation, email: config.ownerEmail } satisfies Owner;
  });

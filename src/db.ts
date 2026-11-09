import { Data, Effect } from "effect";

export class Unavailable extends Data.TaggedError("Unavailable") {}
type Value = string | number | null;

export const first = <T>(db: D1Database, sql: string, values: Value[] = []) =>
  Effect.tryPromise({
    try: () =>
      db
        .prepare(sql)
        .bind(...values)
        .first<T>(),
    catch: () => new Unavailable(),
  });

export const run = (db: D1Database, sql: string, values: Value[] = []) =>
  Effect.tryPromise({
    try: () =>
      db
        .prepare(sql)
        .bind(...values)
        .run(),
    catch: () => new Unavailable(),
  });

export const batch = (db: D1Database, statements: () => D1PreparedStatement[]) =>
  Effect.tryPromise({ try: () => db.batch(statements()), catch: () => new Unavailable() });

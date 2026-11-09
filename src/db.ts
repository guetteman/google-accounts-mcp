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

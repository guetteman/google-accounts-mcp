import { env } from "cloudflare:workers";

export type OwnerState = "unpinned" | "pinned" | "resetting";

export interface OwnerRowValues {
  readonly state: OwnerState;
  readonly generation: number;
  readonly email: string | null;
}

/** Every row of every table the Worker owns, so "D1 unchanged" is a plain equality. */
export async function dump(
  db: D1Database = env.DB,
  kv: KVNamespace = env.OAUTH_KV,
): Promise<Record<string, unknown[]>> {
  const tables = await db
    .prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",
    )
    .all<{ name: string; sql: string }>();
  const out: Record<string, unknown[]> = {};
  for (const { name, sql } of tables.results) {
    const order = /WITHOUT ROWID/i.test(sql)
      ? (
          await db.prepare(`PRAGMA table_info("${name}")`).all<{ name: string; pk: number }>()
        ).results
          .filter((column) => column.pk > 0)
          .sort((a, b) => a.pk - b.pk)
          .map((column) => `"${column.name}"`)
          .join(",")
      : "rowid";
    const rows = await db.prepare(`SELECT * FROM "${name}" ORDER BY ${order}`).all();
    out[name] = rows.results;
  }
  out.OAUTH_KV = await kvDump(kv);
  out.FILES_KV = await kvDump(env.FILES_KV);
  return out;
}

export async function ownerRow(): Promise<OwnerRowValues | null> {
  return env.DB.prepare(
    "SELECT state, generation, email FROM owner WHERE id = 1",
  ).first<OwnerRowValues>();
}

/** The random number the migration gave this database's owner row; the reset guards on it. */
export async function ownerInstance(): Promise<number> {
  const row = await env.DB.prepare("SELECT instance FROM owner WHERE id = 1").first<{
    instance: number;
  }>();
  if (row === null) throw new Error("no owner row");
  return row.instance;
}

export async function setOwner(row: OwnerRowValues): Promise<void> {
  await env.DB.prepare("UPDATE owner SET state = ?, generation = ?, email = ? WHERE id = 1")
    .bind(row.state, row.generation, row.email)
    .run();
}

/** A D1 binding whose every call throws, as when D1 is down. */
export function brokenDb(): D1Database {
  const fail = () => {
    throw new Error("D1_ERROR: Network connection lost.");
  };
  return new Proxy({} as D1Database, { get: () => fail });
}

/** A D1 binding that records any use, to prove a request never reached D1. */
export function watchedDb(): { db: D1Database; calls: string[] } {
  const calls: string[] = [];
  const db = new Proxy({} as D1Database, {
    get: (_target, key) => {
      calls.push(String(key));
      return () => {
        throw new Error(`D1 was used: ${String(key)}`);
      };
    },
  });
  return { db, calls };
}

const WRITE = /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i;

/** Wrap real statements without passing their proxies into D1's native batch implementation. */
export function observeStatements(
  real: D1Database,
  before: (sql: string) => void | Promise<void>,
  after: (sql: string) => void = () => {},
  onResult?: (sql: string, result: D1Result) => void,
): D1Database {
  const originals = new WeakMap<
    D1PreparedStatement,
    { statement: D1PreparedStatement; sql: string }
  >();
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const wrapped = new Proxy(statement, {
      get(target, key) {
        if (key === "bind") return (...values: unknown[]) => wrap(target.bind(...values), sql);
        const value: unknown = Reflect.get(target, key);
        if (key === "run" || key === "all" || key === "first") {
          return async (...args: unknown[]) => {
            await before(sql);
            if (onResult && key === "first") {
              const result = await target.all();
              onResult(sql, result);
              after(sql);
              const row = result.results[0] ?? null;
              return typeof args[0] === "string" && row !== null ? row[args[0]] : row;
            }
            const result = await Reflect.apply(
              value as (...args: unknown[]) => unknown,
              target,
              args,
            );
            onResult?.(sql, result as D1Result);
            after(sql);
            return result;
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    originals.set(wrapped, { statement, sql });
    return wrapped;
  };
  return new Proxy(real, {
    get(target, key) {
      if (key === "prepare") return (sql: string) => wrap(target.prepare(sql), sql);
      if (key === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          const unwrapped: D1PreparedStatement[] = [];
          for (const statement of statements) {
            const original = originals.get(statement);
            if (!original)
              throw new Error("Prepare batch statements through the wrapped database.");
            await before(original.sql);
            unwrapped.push(original.statement);
          }
          const results = await target.batch(unwrapped);
          statements.forEach((statement, i) => {
            const sql = originals.get(statement)!.sql;
            onResult?.(sql, results[i]!);
            after(sql);
          });
          return results;
        };
      }
      const value: unknown = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** Record write attempts even when a statement changes no rows or later fails. */
export function writeRecordingDb(real: D1Database = env.DB): { db: D1Database; writes: string[] } {
  const writes: string[] = [];
  const db = observeStatements(real, (sql) => {
    if (WRITE.test(sql)) writes.push(sql);
  });
  return { db, writes };
}

/** Real reads and writes, except for statements matching the selected failure. */
export function statementFailingDb(pattern: RegExp, real: D1Database = env.DB): D1Database {
  return observeStatements(real, (sql) => {
    pattern.lastIndex = 0;
    if (pattern.test(sql)) throw new Error("D1_ERROR: Network connection lost.");
  });
}

/** The real D1, except that every write fails: reads work, so Access verification runs first. */
export function writeFailingDb(real: D1Database = env.DB): D1Database {
  return statementFailingDb(WRITE, real);
}

export interface KvEntry {
  name: string;
  value: string | null;
  expiration?: number;
  metadata?: unknown;
}

/** Include all pages, values, expiry, and metadata, not just the first 1000 names. */
export async function kvDump(kv: KVNamespace = env.OAUTH_KV): Promise<KvEntry[]> {
  const entries: KvEntry[] = [];
  let cursor: string | undefined;
  do {
    const page = await kv.list({ cursor });
    for (const key of page.keys) entries.push({ ...key, value: await kv.get(key.name) });
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

export async function restoreKv(entries: KvEntry[], kv: KVNamespace = env.OAUTH_KV) {
  for (const entry of entries) {
    if (entry.value !== null)
      await kv.put(entry.name, entry.value, {
        ...(entry.expiration ? { expiration: entry.expiration } : {}),
        ...(entry.metadata === undefined ? {} : { metadata: entry.metadata }),
      });
  }
}

/** Fail every operation, or just access-token persistence after the grant was saved. */
export function failingKv(
  mode: "all" | "token-put",
  real: KVNamespace = env.OAUTH_KV,
): KVNamespace {
  return new Proxy(real, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        if (mode === "all" || (key === "put" && String(args[0]).startsWith("token:")))
          throw new Error("KV unavailable");
        return Reflect.apply(value, target, args);
      };
    },
  });
}

/** The real batch commits, then its response is lost exactly once. */
export function committedConnectionFailureDb(real: D1Database = env.DB): D1Database {
  let failed = false;
  return observeStatements(
    real,
    () => {},
    (sql) => {
      if (!failed && /^\s*INSERT\s+INTO\s+connections\b/i.test(sql)) {
        failed = true;
        throw new Error("D1_ERROR: response lost after commit");
      }
    },
  );
}

/** Change the owner after requireOwner returned, immediately before a connection action writes. */
export function racingConnectionWriteDb(
  changeOwner: () => Promise<void>,
  real: D1Database = env.DB,
) {
  let changed = false;
  return observeStatements(real, async (sql) => {
    if (!changed && /^\s*UPDATE\s+connections\b/i.test(sql)) {
      changed = true;
      await changeOwner();
    }
  });
}

/** D1's measured rows for every prepared execution, including first() and batch(). */
export function readRecordingDb(real: D1Database = env.DB) {
  const reads: { sql: string; rows: number }[] = [];
  const db = observeStatements(
    real,
    () => {},
    () => {},
    (sql, result) => {
      reads.push({ sql, rows: result.meta.rows_read });
    },
  );
  return { db, reads };
}

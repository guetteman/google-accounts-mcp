import { env } from "cloudflare:workers";

export type OwnerState = "unpinned" | "pinned" | "resetting";

export interface OwnerRowValues {
  readonly state: OwnerState;
  readonly generation: number;
  readonly email: string | null;
}

/** Every row of every table the Worker owns, so "D1 unchanged" is a plain equality. */
export async function dump(db: D1Database = env.DB): Promise<Record<string, unknown[]>> {
  const tables = await db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",
    )
    .all<{ name: string }>();
  const out: Record<string, unknown[]> = {};
  for (const { name } of tables.results) {
    const rows = await db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all();
    out[name] = rows.results;
  }
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
function observeStatements(real: D1Database, before: (sql: string) => void): D1Database {
  const originals = new WeakMap<
    D1PreparedStatement,
    { statement: D1PreparedStatement; sql: string }
  >();
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const wrapped = new Proxy(statement, {
      get(target, key) {
        if (key === "bind") return (...values: unknown[]) => wrap(target.bind(...values), sql);
        const value: unknown = Reflect.get(target, key);
        if (key === "run" || key === "all" || key === "first" || key === "raw") {
          return (...args: unknown[]) => {
            before(sql);
            return Reflect.apply(value as (...args: unknown[]) => unknown, target, args);
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
        return (statements: D1PreparedStatement[]) => {
          const unwrapped = statements.map((statement) => {
            const original = originals.get(statement);
            if (!original)
              throw new Error("Prepare batch statements through the wrapped database.");
            before(original.sql);
            return original.statement;
          });
          return target.batch(unwrapped);
        };
      }
      if (key === "exec") {
        return (sql: string) => {
          for (const statement of sql.split(/[;\n]/)) before(statement);
          return target.exec(sql);
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

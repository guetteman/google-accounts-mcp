export interface D1BindingConfig {
  readonly binding: string;
  readonly database_name?: string;
  readonly database_id?: string;
  readonly preview_database_id?: string;
}

/**
 * Names the database that `wrangler d1 execute` changes, the way wrangler picks it. Remote: by
 * `database_id` when the configuration has one, otherwise by `database_name`, otherwise by the
 * name wrangler gives a database it provisioned, `<worker name>-<binding>`. Local: the local
 * state is keyed by `preview_database_id`, then `database_id`, then the binding.
 */
export function databaseLabel(
  worker: string | undefined,
  db: D1BindingConfig,
  mode: "local" | "remote",
): string {
  const id = mode === "local" ? (db.preview_database_id ?? db.database_id) : db.database_id;
  const suffix = ` (${mode})`;
  if (id) return `${db.database_name ? `${db.database_name}, ` : ""}id ${id}${suffix}`;
  if (db.database_name) return `${db.database_name}${suffix}`;
  if (!worker) throw new Error("The configuration names no D1 database for DB and no Worker name.");
  return `${worker}-${db.binding.toLowerCase().replaceAll("_", "-")}${suffix}`;
}

/**
 * The configuration's `DB` database, as `wrangler d1 execute DB` finds it: the first entry whose
 * binding or database_name is `DB`. Refuses a configuration where that could be a database other
 * than the Worker's `DB` binding, so the reset never changes a database it did not name.
 */
export function ownerDatabase(databases: ReadonlyArray<D1BindingConfig>): D1BindingConfig {
  const matches = databases.filter((db) => db.binding === "DB" || db.database_name === "DB");
  if (matches.length > 1)
    throw new Error(
      "The configuration names more than one D1 database DB (as a binding or a database_name); rename one so the reset cannot change the wrong database.",
    );
  const [only] = matches;
  if (!only || only.binding !== "DB")
    throw new Error("The configuration has no D1 binding named DB.");
  return only;
}

export interface WranglerTarget {
  readonly mode: "local" | "remote" | "preview";
  readonly id: string;
  /** Where local state lives; absent remotely. */
  readonly path?: string;
}

/**
 * The database wrangler says it used, from the line `d1 execute` prints before it runs SQL
 * (wrangler 4.158.0: "Executing on <local|remote|preview> database <name> (<id>)"). Locally the id
 * is the key of the local state; remotely it is the database's UUID.
 */
export function wranglerTarget(output: string): WranglerTarget | null {
  const match =
    /Executing on (local|remote|preview) database \S+ \(([^)]+)\)(?: from (.+))?:\s*$/m.exec(
      output,
    );
  if (!match?.[1] || !match[2]) return null;
  return {
    mode: match[1] as WranglerTarget["mode"],
    id: match[2],
    ...(match[3] ? { path: match[3] } : {}),
  };
}

/**
 * Whether the database wrangler reported is the configured one. Remotely, wrangler 4.158.0 labels
 * a database "preview" whenever the configuration has a preview_database_id, even though it runs
 * on database_id, so "preview" counts as remote here and the ID decides.
 */
export function targetMatches(
  target: WranglerTarget,
  db: D1BindingConfig,
  mode: "local" | "remote",
): boolean {
  const expected = expectedTargetId(db, mode);
  const modeMatches =
    mode === "local"
      ? target.mode === "local"
      : target.mode === "remote" || target.mode === "preview";
  return modeMatches && (expected === undefined || target.id === expected);
}

export const sameTarget = (a: WranglerTarget, b: WranglerTarget): boolean =>
  a.mode === b.mode && a.id === b.id && a.path === b.path;

/**
 * The id wrangler must report for the configured database: locally the key of its local state
 * (preview_database_id, then database_id, then the binding); remotely its database_id, or
 * undefined when wrangler finds it by name.
 */
export function expectedTargetId(
  db: D1BindingConfig,
  mode: "local" | "remote",
): string | undefined {
  return mode === "local"
    ? (db.preview_database_id ?? db.database_id ?? db.binding)
    : db.database_id;
}

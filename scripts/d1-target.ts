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
  const [first] = matches;
  if (!first || first.binding !== "DB")
    throw new Error("The configuration has no D1 binding named DB.");
  if (matches.length > 1)
    throw new Error(
      "The configuration names more than one D1 database DB (as a binding or a database_name); rename one so the reset cannot change the wrong database.",
    );
  return first;
}

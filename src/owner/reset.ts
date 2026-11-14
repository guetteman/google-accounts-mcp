export type OwnerState = "unpinned" | "pinned" | "resetting";

export interface ResetPlan {
  readonly generation: number;
  readonly resuming: boolean;
  readonly statements: ReadonlyArray<string>;
}

export type ResetOutcome = "done" | "overtaken" | "unknown";

/** Every table that holds the previous owner's data. */
const OWNER_TABLES = [
  "connections",
  "accounts",
  "permissions",
  "calls",
  "call_accounts",
  "approvals",
  "once",
  "uploads",
];

/**
 * The statements of a reset of the database whose owner row was read as `row`. Every statement
 * is guarded on that database's `instance` and on the reset's generation, so statements that
 * reach another database, a newer reset, or a finished one change nothing.
 */
export const resetPlan = (row: {
  state: OwnerState;
  generation: number;
  instance: number;
}): ResetPlan => {
  const resuming = row.state === "resetting";
  const generation = row.generation + (resuming ? 0 : 1);
  const { instance } = row;
  // These numbers are written into the SQL text below.
  if (!Number.isSafeInteger(generation) || !Number.isSafeInteger(instance))
    throw new Error("Reset generation and instance must be safe integers.");
  const guard = `EXISTS (SELECT 1 FROM owner WHERE id = 1 AND instance = ${instance} AND state = 'resetting' AND generation = ${generation})`;
  return {
    generation,
    resuming,
    statements: [
      ...(resuming
        ? []
        : [
            `UPDATE owner SET state = 'resetting', generation = ${generation} WHERE id = 1 AND instance = ${instance} AND generation = ${row.generation} AND state <> 'resetting' RETURNING generation`,
          ]),
      ...OWNER_TABLES.map((table) => `DELETE FROM ${table} WHERE ${guard}`),
      `UPDATE owner SET state = 'unpinned', email = NULL WHERE id = 1 AND instance = ${instance} AND state = 'resetting' AND generation = ${generation} RETURNING generation`,
    ],
  };
};

export const resetOutcome = (
  plan: ResetPlan,
  results: ReadonlyArray<{ readonly results: ReadonlyArray<unknown> }>,
): ResetOutcome => {
  if (!plan.resuming && results[0]?.results.length === 0) return "overtaken";
  if (results.length === plan.statements.length && results.at(-1)?.results.length) return "done";
  return "unknown";
};

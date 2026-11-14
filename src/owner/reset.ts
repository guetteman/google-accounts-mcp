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
 * The statements of a reset of the owner row read as `row`. The reset begins only while the row
 * still has the state and generation that were read, so an owner who signed in meanwhile is kept.
 * Every later statement is guarded on the reset's generation, so statements that reach a newer
 * reset or a finished one change nothing.
 */
export const resetPlan = (row: { state: OwnerState; generation: number }): ResetPlan => {
  const resuming = row.state === "resetting";
  const generation = row.generation + (resuming ? 0 : 1);
  const from = row.state === "pinned" ? "pinned" : "unpinned";
  // These numbers are written into the SQL text below.
  if (!Number.isSafeInteger(generation))
    throw new Error("Reset generation must be a safe integer.");
  const guard = `EXISTS (SELECT 1 FROM owner WHERE id = 1 AND state = 'resetting' AND generation = ${generation})`;
  return {
    generation,
    resuming,
    statements: [
      ...(resuming
        ? []
        : [
            `UPDATE owner SET state = 'resetting', generation = ${generation} WHERE id = 1 AND generation = ${row.generation} AND state = '${from}' RETURNING generation`,
          ]),
      ...OWNER_TABLES.map((table) => `DELETE FROM ${table} WHERE ${guard}`),
      `UPDATE owner SET state = 'unpinned', email = NULL WHERE id = 1 AND state = 'resetting' AND generation = ${generation} RETURNING generation`,
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

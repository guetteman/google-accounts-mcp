export type OwnerState = "unpinned" | "pinned" | "resetting";

export interface ResetPlan {
  readonly generation: number;
  readonly resuming: boolean;
  readonly statements: ReadonlyArray<string>;
}

export type ResetOutcome = "done" | "overtaken" | "unknown";

export const RESET_CLEANUP: ReadonlyArray<(c: { guard: string; now: number }) => string> = [
  ({ guard }) => `DELETE FROM connections WHERE ${guard}`,
];

/**
 * The statements of a reset of the database whose owner row was read as `row`. Every statement
 * is guarded on that database's `instance` and on the reset's generation, so statements that
 * reach another database, a newer reset, or a finished one change nothing.
 */
export const resetPlan = (
  row: { state: OwnerState; generation: number; instance: number },
  now: number,
): ResetPlan => {
  if (
    !Number.isSafeInteger(row.generation) ||
    row.generation < 1 ||
    !Number.isSafeInteger(row.instance) ||
    row.instance < 1 ||
    !Number.isSafeInteger(now)
  ) {
    throw new Error(
      "Reset generation, instance, and time must be safe integers; generation and instance must be positive.",
    );
  }
  const resuming = row.state === "resetting";
  const generation = row.generation + (resuming ? 0 : 1);
  if (!Number.isSafeInteger(generation))
    throw new Error("Reset generation exceeds the safe integer range.");
  const { instance } = row;
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
      ...RESET_CLEANUP.map((cleanup) => cleanup({ guard, now })),
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

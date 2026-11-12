import { Effect, Result } from "effect";
import { readConfig } from "../config";
import { readOwner, standing } from "../owner/owner";
import { cleanupApprovals } from "./store";
import { cleanupStatement } from "../once/store";
export async function scheduled(_event: ScheduledController, env: Env) {
  const config = readConfig(env);
  if (Result.isFailure(config)) return;
  const owner = await Effect.runPromise(Effect.result(readOwner(env.DB)));
  if (
    Result.isFailure(owner) ||
    standing(owner.success, config.success)._tag !== "Open" ||
    owner.success.state !== "pinned"
  )
    return;
  await Effect.runPromise(
    cleanupApprovals(
      {
        db: env.DB,
        owner: { generation: owner.success.generation, email: config.success.ownerEmail },
      },
      Date.now(),
    ),
  );
  await cleanupStatement(env.DB, Date.now()).run();
}

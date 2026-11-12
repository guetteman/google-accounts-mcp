import { env } from "cloudflare:workers";
import { Effect, Result } from "effect";
import { expect, it } from "vite-plus/test";
import "./support/account-checks";
import { allowedAccountStatement, seenAccountStatement } from "../src/accounts/store";
import { readConfig } from "../src/config";
import { parseConnectionId } from "../src/connections/model";
import type { CallContext } from "../src/mcp/call";
import { parseAccountTool } from "../src/mcp/tools";
import { normalizeEmail, readOwner } from "../src/owner/owner";
import { fixture, permission, PERSONAL } from "./support/permissions";
import { ORIGIN, testEnv } from "./support/worker";

const context = async (f: Awaited<ReturnType<typeof fixture>>): Promise<CallContext> => {
  const config = readConfig(testEnv());
  if (Result.isFailure(config)) throw config.failure;
  const owner = await Effect.runPromise(readOwner(env.DB));
  return {
    db: env.DB,
    config: config.success,
    owner: { generation: owner.generation, email: owner.email! },
    connection: { connectionId: parseConnectionId(f.connection.id)!, app: f.connection.app },
    origin: ORIGIN,
    now: Date.now,
    waitUntil: () => {},
  };
};

it("reads no credential for a denied tool and only the seen marker for its visible account", async () => {
  const f = await fixture();
  await permission(f, f.personal, true, "search_threads");
  const ctx = await context(f);
  const account = normalizeEmail(PERSONAL)!;
  expect(
    await allowedAccountStatement(ctx, parseAccountTool("list_labels")!, account).first(),
  ).toBeNull();
  expect(await seenAccountStatement(ctx, account).first()).toEqual({ seen: 1 });
  await permission(f, f.personal, false, "search_threads");
  expect(await seenAccountStatement(ctx, account).first()).toBeNull();
});

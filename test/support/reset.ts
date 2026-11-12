import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { TestEnv } from "../env";

export async function resetBindings(): Promise<void> {
  // workerd resets SQLite through live instances. Reopen idle-evicted bindings first;
  // their backing databases otherwise survive reset(), including d1_migrations.
  // https://github.com/cloudflare/workerd/blob/v1.20261023.1/src/workerd/server/server/actor.rs#L230
  await Promise.all([env.DB.prepare("SELECT 1").run(), env.OAUTH_KV.list({ limit: 1 })]);
  await reset();
  await applyD1Migrations(env.DB, (env as TestEnv).TEST_MIGRATIONS);
}

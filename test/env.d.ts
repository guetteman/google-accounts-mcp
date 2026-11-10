import type { D1Migration } from "cloudflare:test";

export interface TestEnv extends Env {
  readonly TEST_MIGRATIONS: D1Migration[];
  readonly TEST_BROWSER: Fetcher;
}

import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, expect, vi } from "vite-plus/test";
import type { TestEnv } from "./env";

beforeEach(async () => {
  // Resolve fixtures after a test's hoisted module reset, so mocked SSR components and
  // the JWKS handler still use the same test keys and environment as the request helper.
  const { network, unhandledFrames } = await import("./support/network");
  const { access } = await import("./support/access");
  const { freshAccessIssuer } = await import("./support/worker");
  network.enable();
  unhandledFrames.length = 0;
  await reset();
  await applyD1Migrations(env.DB, (env as TestEnv).TEST_MIGRATIONS);
  freshAccessIssuer();
  access.reset();
  network.use(...access.handlers());
});

afterEach(async () => {
  const { access } = await import("./support/access");
  const { network, unhandledFrames } = await import("./support/network");
  access.release();
  vi.useRealTimers();
  network.resetHandlers();
  network.disable();
  expect(unhandledFrames).toEqual([]);
});

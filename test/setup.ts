import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterAll, afterEach, beforeAll, beforeEach, expect, vi } from "vite-plus/test";
import type { TestEnv } from "./env";
import { network, unhandledFrames } from "./support/network";

beforeAll(() => network.enable());

beforeEach(async () => {
  unhandledFrames.length = 0;
  // This plugin version shares bindings until explicitly reset between examples.
  await reset();
  await applyD1Migrations(env.DB, (env as TestEnv).TEST_MIGRATIONS);
});

afterEach(() => {
  vi.useRealTimers();
  network.resetHandlers();
  expect(unhandledFrames).toEqual([]);
});

afterAll(() => network.disable());

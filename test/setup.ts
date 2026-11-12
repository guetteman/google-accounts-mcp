import { afterEach, beforeEach, expect, vi } from "vite-plus/test";
import { resetBindings } from "./support/reset";

beforeEach(async () => {
  // Resolve fixtures after a test's hoisted module reset, so mocked SSR components and
  // the JWKS handler still use the same test keys and environment as the request helper.
  const { network, unhandledFrames, requests } = await import("./support/network");
  const { access } = await import("./support/access");
  const { freshAccessIssuer } = await import("./support/worker");
  network.enable();
  unhandledFrames.length = 0;
  requests.length = 0;
  await resetBindings();
  freshAccessIssuer();
  access.reset();
  const { oauth } = await import("./support/oauth");
  oauth.reset();
  network.use(...access.handlers(), ...oauth.handlers());
});

afterEach(async () => {
  const { access } = await import("./support/access");
  const { network, unhandledFrames } = await import("./support/network");
  access.release();
  vi.useRealTimers();
  vi.restoreAllMocks();
  network.resetHandlers();
  network.disable();
  expect(unhandledFrames).toEqual([]);
});

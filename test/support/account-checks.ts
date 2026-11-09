import { beforeEach, afterEach, expect, vi } from "vite-plus/test";
import { google, MARKER } from "./google";
import { network } from "./network";
import { kvDump, setOwner } from "./db";
import { NOW } from "./accounts";
import { observedBodies, OWNER_EMAIL } from "./worker";

beforeEach(async () => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  await setOwner({ state: "pinned", generation: 1, email: OWNER_EMAIL });
  google.reset();
  network.use(...google.handlers());
  observedBodies.length = 0;
  for (const method of ["log", "warn", "error", "info", "debug"] as const)
    vi.spyOn(console, method);
});
afterEach(async () => {
  google.release();
  const output = [await kvDump(), observedBodies];
  for (const method of ["log", "warn", "error", "info", "debug"] as const)
    output.push(vi.mocked(console[method]).mock?.calls ?? []);
  expect(
    JSON.stringify(output),
    "Google tokens stay out of KV, grant props, logs, HTML, hydration props and response bodies",
  ).not.toContain(MARKER);
});

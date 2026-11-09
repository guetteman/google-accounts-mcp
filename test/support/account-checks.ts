import { beforeEach, afterEach, expect, vi } from "vite-plus/test";
import { google, issuedTokens, MARKER } from "./google";
import { network } from "./network";
import { kvDump, setOwner } from "./db";
import { NOW } from "./accounts";
import { observedBodies, OWNER_EMAIL } from "./worker";

const consoleSpies: Array<{ mock: { calls: unknown[][] } }> = [];
export const recordedConsole = () => consoleSpies.flatMap((spy) => spy.mock.calls);

beforeEach(async () => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  await setOwner({ state: "pinned", generation: 1, email: OWNER_EMAIL });
  google.reset();
  network.use(...google.handlers());
  observedBodies.length = 0;
  consoleSpies.length = 0;
  for (const method of ["log", "warn", "error", "info", "debug"] as const)
    consoleSpies.push(vi.spyOn(console, method).mockImplementation(() => {}));
});
afterEach(async () => {
  google.release();
  const output = [await kvDump(), observedBodies];
  output.push(recordedConsole());
  expect(
    JSON.stringify(output),
    "Google tokens stay out of KV, grant props, logs, HTML, hydration props and response bodies",
  ).not.toContain(MARKER);
  for (const value of issuedTokens)
    expect(
      JSON.stringify(output),
      "No issued Google token may escape, including the raw ID token",
    ).not.toContain(value);
});

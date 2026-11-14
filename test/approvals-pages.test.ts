import { env } from "cloudflare:workers";
import { expect, it } from "vite-plus/test";
import "./support/account-checks";
import { fixture } from "./support/permissions";
import { ask, page, setting } from "./support/approvals";
import type { TestEnv } from "./env";
import { ORIGIN } from "./support/worker";

it.each(["approve", "reject", "changed", "lost", "503"] as const)(
  "hydrates the approval page and handles %s in place",
  async (scenario) => {
    const f = await fixture();
    await setting(f, "ask");
    const id = await ask(f);
    const initial = await page(f, id);
    const response = await f.mcp.browser.get(`/approvals/${id}`);
    const next = {
      ...initial,
      state:
        scenario === "changed"
          ? { kind: "waiting" as const, changed: true, shown: true, digest: "changed" }
          : { kind: scenario === "reject" ? ("rejected" as const) : ("succeeded" as const) },
    };
    const hydrated = await (
      await (env as TestEnv).TEST_BROWSER.fetch("http://browser/hydrate", {
        method: "POST",
        body: JSON.stringify({
          url: `${ORIGIN}/approvals/${id}`,
          html: await response.text(),
          headers: Object.fromEntries(response.headers),
          approval: {
            action: scenario === "reject" ? "reject" : "approve",
            response: next,
            ...(["lost", "503"].includes(scenario) ? { failure: scenario } : {}),
          },
        }),
      })
    ).json<{
      clientLoads: number;
      inFlight: {
        text: string;
        busy: string;
        spinner: number;
        before: unknown;
        after: unknown;
        buttonsBefore: unknown;
        buttonsAfter: unknown;
      };
      submissions: Record<string, string>[];
      reload: number;
      errors: string[];
    }>();
    expect(hydrated.errors).toEqual([]);
    expect(hydrated.clientLoads).toBe(1);
    if (scenario !== "reject") {
      expect(hydrated.inFlight.text).toContain("Sending your approval");
      expect(hydrated.inFlight.text).toContain("Approving…");
      expect(hydrated.inFlight.text).toContain("If the call runs, it can take up to 25 seconds.");
      expect(hydrated.inFlight.text).not.toContain("Approved. The call is running.");
      expect(hydrated.inFlight.busy).toBe("true");
      expect(hydrated.inFlight.spinner).toBe(1);
      expect(hydrated.inFlight.after).toEqual(hydrated.inFlight.before);
      expect(hydrated.inFlight.buttonsAfter).toEqual(hydrated.inFlight.buttonsBefore);
    }
    expect(hydrated.submissions).toEqual([
      scenario === "reject"
        ? {}
        : { digest: initial.state.kind === "waiting" ? initial.state.digest : "" },
    ]);
    expect(hydrated.reload).toBe(["lost", "503"].includes(scenario) ? 1 : 0);
  },
  30_000,
);
it.each(["double", "identity", "digest"] as const)(
  "protects approval submissions against %s mistakes",
  async (protection) => {
    const f = await fixture();
    await setting(f, "ask");
    const id = await ask(f);
    const initial = await page(f, id);
    const response = await f.mcp.browser.get(`/approvals/${id}`);
    const succeeded = { ...initial, state: { kind: "succeeded" as const } };
    const next =
      protection === "identity"
        ? { ...succeeded, id: crypto.randomUUID() }
        : protection === "digest"
          ? {
              ...initial,
              state: {
                kind: "waiting" as const,
                shown: true,
                changed: true,
                digest: "new-reviewed-digest",
              },
            }
          : succeeded;
    const result = await (
      await (env as TestEnv).TEST_BROWSER.fetch("http://browser/hydrate", {
        method: "POST",
        body: JSON.stringify({
          url: `${ORIGIN}/approvals/${id}`,
          html: await response.text(),
          headers: Object.fromEntries(response.headers),
          approval: { action: "approve", protection, response: next, nextResponse: succeeded },
        }),
      })
    ).json<{ submissions: Record<string, string>[]; reload: number; errors: string[] }>();
    expect(result.errors).toEqual([]);
    const originalDigest = initial.state.kind === "waiting" ? initial.state.digest : null;
    expect(result.submissions).toEqual(
      protection === "digest"
        ? [{ digest: originalDigest }, { digest: "new-reviewed-digest" }]
        : [{ digest: originalDigest }],
    );
    expect(result.reload).toBe(protection === "identity" ? 1 : 0);
  },
  30_000,
);

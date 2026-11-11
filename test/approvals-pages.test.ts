import { env } from "cloudflare:workers";
import { expect, it } from "vite-plus/test";
import "./support/account-checks";
import { previews } from "../src/pages/previews";
import { renderPage } from "../src/pages/render";
import { fixture } from "./support/permissions";
import { ask, page, setting } from "./support/approvals";
import type { TestEnv } from "./env";
import { ORIGIN } from "./support/worker";

it("renders every approval preview with the shared hydration entry and no prototype controls", async () => {
  for (const name of [
    "waiting",
    "waiting-long-names",
    "cannot-show",
    "changed",
    "running",
    "succeeded",
    "failed",
    "unknown",
    "rejected",
    "expired",
    "ended-tool",
    "ended-connection",
    "ended-account",
    "unconfirmed",
  ]) {
    const preview = previews[`approval-${name}`];
    expect(preview).toBeDefined();
    const html = await renderPage(preview!).text();
    expect(html).toContain('id="page-props"');
    expect(html).toContain("/src/pages/client.tsx");
    expect(html).not.toContain("/__proto");
    if (
      [
        "running",
        "succeeded",
        "failed",
        "unknown",
        "rejected",
        "expired",
        "ended-tool",
        "ended-connection",
        "ended-account",
        "unconfirmed",
      ].includes(name)
    ) {
      expect(html).not.toContain(">Approve</button>");
      expect(html).not.toContain(">Reject</button>");
    }
    if (name === "succeeded") {
      expect(html).toContain("This page does not show the result.");
      expect(html).not.toContain("The result goes to the agent");
    }
    if (name === "unconfirmed") expect(html).toContain(">Reload</a>");
    if (name === "ended-tool") expect(html).toContain('href="/connections/');
    if (name === "ended-account") expect(html).toContain('href="/accounts"');
  }
});
it.each(["approve", "reject", "changed", "lost", "503"] as const)(
  "hydrates the real Worker page and handles %s in place",
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
it.each([
  { width: 390, dark: false },
  { width: 390, dark: true },
  { width: 1280, dark: false },
  { width: 1280, dark: true },
])(
  "renders approval pages at $width px with dark=$dark without overflow",
  async ({ width, dark }) => {
    for (const name of [
      "waiting-long-names",
      "cannot-show",
      "changed",
      "succeeded",
      "failed",
      "unconfirmed",
    ]) {
      const response = renderPage(previews[`approval-${name}`]!);
      const hydrated = await (
        await (env as TestEnv).TEST_BROWSER.fetch("http://browser/hydrate", {
          method: "POST",
          body: JSON.stringify({
            url: `${ORIGIN}/__pages/approval-${name}`,
            html: await response.text(),
            headers: Object.fromEntries(response.headers),
            width,
            dark,
            screenshot: `approval-${name}-${width}-${dark ? "dark" : "light"}`,
          }),
        })
      ).json<{ clientLoads: number; overflow: boolean; errors: string[] }>();
      expect(hydrated.errors).toEqual([]);
      expect(hydrated.clientLoads).toBe(1);
      expect(hydrated.overflow).toBe(false);
    }
  },
  60_000,
);

it.each([390, 1280])(
  "renders the real three-option connection control at %s px",
  async (width) => {
    const response = renderPage(previews["connection-some-allowed"]!);
    const hydrated = await (
      await (env as TestEnv).TEST_BROWSER.fetch("http://browser/hydrate", {
        method: "POST",
        body: JSON.stringify({
          url: `${ORIGIN}/__pages/connection-some-allowed`,
          html: await response.text(),
          headers: Object.fromEntries(response.headers),
          width,
          screenshot: `connection-ask-${width}`,
        }),
      })
    ).json<{ clientLoads: number; overflow: boolean; errors: string[] }>();
    expect(hydrated.errors).toEqual([]);
    expect(hydrated.clientLoads).toBe(1);
    expect(hydrated.overflow).toBe(false);
  },
  30_000,
);

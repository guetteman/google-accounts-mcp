import { describe, expect, it, vi } from "vite-plus/test";
import { Browser } from "./support/browser";
import { access } from "./support/access";
import {
  ACCESS_REFUSED,
  ACCESS_UNAVAILABLE,
  MISMATCH,
  NOT_OWNER,
  PRODUCT,
  SETUP_INCOMPLETE,
  UNAVAILABLE,
} from "./support/copy";
import { brokenDb, setOwner } from "./support/db";
import { formsOf, HOST, OWNER_EMAIL, testEnv, textOf } from "./support/worker";

// Radix portals have no document in SSR. Expose only their children so the Worker's actual
// owner menu links can be inspected here; Playwright also checks the real hydrated portal in captures.
vi.hoisted(() => vi.resetModules());
vi.mock("../src/components/ui/dropdown-menu", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui/dropdown-menu")>();
  return {
    ...actual,
    DropdownMenuContent: ({ children }: { children: import("react").ReactNode }) => children,
    DropdownMenuItem: ({ children }: { children: import("react").ReactNode }) => children,
  };
});

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
  "base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const scripts = (html: string) => [...html.matchAll(/<script\b([^>]*)>/gi)].map((m) => m[1] ?? "");
function expectPageHeaders(response: Response) {
  expect(response.headers.get("Content-Type")).toMatch(/^text\/html/);
  expect(response.headers.get("Content-Security-Policy")).toBe(CSP);
  expect(response.headers.get("Referrer-Policy")).toBe("same-origin");
  expect(response.headers.get("Cache-Control")).toBe("no-store");
}

describe("standalone pages", () => {
  it("ship a stylesheet and security headers without scripts on every refusal page", async () => {
    const visitor = new Browser();
    const refused = await visitor.get("/accounts");
    await visitor.authenticate({ email: "someone.else@example.net" });
    const notOwner = await visitor.get("/accounts");
    // A fresh issuer forces a fetch even after the preceding successful verification.
    const down = new Browser(() =>
      testEnv({ ACCESS_ISSUER: "https://outage.cloudflareaccess.com" }),
    );
    await down.authenticate({ iss: "https://outage.cloudflareaccess.com" });
    access.mode = "fail";
    const outage = await down.get("/accounts");
    access.mode = "ok";
    await setOwner({ state: "pinned", generation: 1, email: OWNER_EMAIL });
    const mismatch = await visitor.get("/accounts", {
      env: testEnv({ OWNER_EMAIL: "alex.new@example.com" }),
    });
    const setup = await visitor.get("/accounts", { env: testEnv({ ACCESS_AUDIENCE: undefined }) });
    const database = await visitor.get("/accounts", { env: testEnv({ DB: brokenDb() }) });
    for (const [response, title] of [
      [refused, ACCESS_REFUSED.title],
      [notOwner, NOT_OWNER.title],
      [outage, ACCESS_UNAVAILABLE.title],
      [mismatch, MISMATCH.title],
      [setup, SETUP_INCOMPLETE.title],
      [database, UNAVAILABLE.title],
    ] as const) {
      expectPageHeaders(response);
      const html = await response.text();
      expect(textOf(html)).toContain(title);
      expect(textOf(html)).toContain(PRODUCT);
      expect(scripts(html)).toEqual([]);
      expect(html).toContain('rel="stylesheet"');
    }
  });
});

describe("owner pages", () => {
  it.each([
    [
      "/accounts",
      "Accounts",
      "Google accounts your agents can use. Each connection sees only the ones you grant.",
    ],
    [
      "/connections",
      "Connections",
      "Apps that signed in to this server. Each starts with no access to your accounts.",
    ],
  ])(
    "renders %s in the frame with one Access sign-out link and escaped hydration props",
    async (path, title, description) => {
      const owner = new Browser();
      await owner.authenticate();
      const response = await owner.get(path);
      expect(response.status).toBe(200);
      expectPageHeaders(response);
      const html = await response.text();
      const text = textOf(html);
      for (const value of [PRODUCT, HOST, title, description, OWNER_EMAIL])
        expect(text).toContain(value);
      expect(html).toMatch(/<a\b[^>]*href="\/accounts"/);
      expect(html).toMatch(/<a\b[^>]*href="\/connections"/);
      expect(html).toMatch(
        new RegExp(
          `<a\\b[^>]*href="${path}"[^>]*aria-current="page"|<a\\b[^>]*aria-current="page"[^>]*href="${path}"`,
        ),
      );
      expect(html).toMatch(/<a\b[^>]*href="\/cdn-cgi\/access\/logout"[^>]*>Sign out<\/a>/);
      expect(text).not.toContain("Sign out of all devices");
      expect(formsOf(html)).toEqual([]);
      const executable = scripts(html).filter((attrs) => !/type="application\/json"/.test(attrs));
      expect(executable.length).toBeGreaterThan(0);
      for (const attrs of executable) {
        expect(attrs).toMatch(/\bsrc="\//);
        expect(attrs).toMatch(/\btype="module"/);
      }
      const blob =
        /<script\b[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/i.exec(html)?.[1] ?? "";
      expect(blob).not.toMatch(/[<>&]/);
      expect(JSON.stringify(JSON.parse(blob))).toContain(OWNER_EMAIL);
    },
  );
});

describe("unimplemented and removed routes", () => {
  it("returns 404 for unknown paths and the removed Google sign-in and session endpoints", async () => {
    const browser = new Browser();
    for (const path of ["/nothing-here", "/assets/missing.js", "/signin"])
      expect((await browser.get(path)).status, path).toBe(404);
    for (const path of ["/signin", "/signout", "/signout/all"])
      expect((await browser.post(path)).status, path).toBe(404);
  });
});

it("challenges an unauthenticated MCP request instead of serving a page", async () => {
  const response = await new Browser().get("/mcp");
  expect(response.status).toBe(401);
  expect(response.headers.get("WWW-Authenticate")).toContain('Bearer realm="OAuth"');
  expect(response.headers.get("WWW-Authenticate")).toContain(
    `resource_metadata="https://accounts-mcp.example.com/.well-known/oauth-protected-resource/mcp"`,
  );
  expect(response.headers.get("Cache-Control")).toBe("no-store");
});
it("refuses an unidentified token client instead of serving a page", async () => {
  const response = await new Browser().post("/oauth/token");
  expect(response.status).toBe(401);
  expect(await response.json()).toMatchObject({ error: "invalid_client" });
});

import { describe, expect, it } from "vite-plus/test";
import { Browser } from "./support/browser";
import { DIDNT_FINISH, MISMATCH, NOT_OWNER, PRODUCT, SIGN_IN } from "./support/copy";
import { formsOf, HOST, OWNER_EMAIL, testEnv, textOf } from "./support/worker";

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
  "base-uri 'none'; form-action 'self' https://accounts.google.com; frame-ancestors 'none'";

const scripts = (html: string) => [...html.matchAll(/<script\b([^>]*)>/gi)].map((m) => m[1] ?? "");
const executable = (html: string) =>
  scripts(html).filter((attrs) => !/type="application\/json"/.test(attrs));

function expectPageHeaders(response: Response) {
  expect(response.headers.get("Content-Type")).toMatch(/^text\/html/);
  expect(response.headers.get("Content-Security-Policy")).toBe(CSP);
  expect(response.headers.get("Referrer-Policy")).toBe("same-origin");
  expect(response.headers.get("Cache-Control")).toBe("no-store");
}

describe("standalone pages", () => {
  it("ship no script and send the security headers", async () => {
    const visitor = new Browser();
    const signIn = await visitor.get("/signin");
    const notOwner = await visitor.signIn({ email: "someone.else@example.net", sub: "sub-x" });
    const owner = new Browser();
    await owner.signInAsOwner();
    const mismatch = await owner.get("/accounts", {
      env: testEnv({ OWNER_EMAIL: "alex.new@example.com" }),
    });

    for (const [label, response, title] of [
      ["sign-in", signIn, SIGN_IN.title],
      ["not the owner", notOwner, NOT_OWNER.title],
      ["mismatch", mismatch, MISMATCH.title],
    ] as const) {
      expectPageHeaders(response);
      const html = await response.text();
      expect(textOf(html), label).toContain(title);
      expect(textOf(html), label).toContain(PRODUCT);
      expect(scripts(html), label).toEqual([]);
      expect(html, label).toContain('rel="stylesheet"');
    }
  });

  it("put the sign-in problem above the button", async () => {
    const response = await new Browser().callback({ code: "c", state: "s" });
    const html = textOf(await response.text());
    expect(html.indexOf(DIDNT_FINISH.title)).toBeGreaterThan(-1);
    expect(html.indexOf(DIDNT_FINISH.title)).toBeLessThan(html.indexOf(SIGN_IN.button));
  });
});

describe("signed-in pages", () => {
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
    "render %s in the frame and hydrate it from an escaped props blob",
    async (path, title, description) => {
      const owner = new Browser();
      await owner.signInAsOwner();

      const response = await owner.get(path);

      expect(response.status).toBe(200);
      expectPageHeaders(response);
      const html = await response.text();
      const text = textOf(html);
      expect(text).toContain(PRODUCT);
      expect(text).toContain(HOST);
      expect(text).toContain(title);
      expect(text).toContain(description);
      expect(text).toContain(OWNER_EMAIL);
      expect(html).toMatch(/<a\b[^>]*href="\/accounts"/);
      expect(html).toMatch(/<a\b[^>]*href="\/connections"/);
      expect(html).toMatch(
        new RegExp(
          `<a\\b[^>]*href="${path}"[^>]*aria-current="page"|<a\\b[^>]*aria-current="page"[^>]*href="${path}"`,
        ),
      );
      const forms = formsOf(html).map((f) => `${f.method} ${f.action}`);
      expect(forms).toContain("post /signout");
      expect(forms).toContain("post /signout/all");

      const run = executable(html);
      expect(run.length).toBeGreaterThan(0);
      for (const attrs of run) {
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

describe("paths with nothing behind them", () => {
  it("answer 404 while the deploy is open, including /mcp and /oauth/token until #9", async () => {
    const browser = new Browser();
    for (const path of ["/nothing-here", "/assets/missing.js", "/mcp"]) {
      expect((await browser.get(path)).status, path).toBe(404);
    }
    expect((await browser.post("/oauth/token", { grant_type: "authorization_code" })).status).toBe(
      404,
    );
  });
});

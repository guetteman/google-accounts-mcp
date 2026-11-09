import { describe, expect, it, vi } from "vite-plus/test";
import { Browser, clears, setCookies } from "./support/browser";
import { DIDNT_FINISH, GOOGLE_DOWN, NOT_OWNER, PRODUCT, SIGN_IN } from "./support/copy";
import { dump, ownerRow, sessions, setOwner } from "./support/db";
import { base64url, fromBase64url, google, GOOGLE_AUTHORIZE } from "./support/google";
import { formsOf, HOST, location, ORIGIN, OWNER_EMAIL, textOf } from "./support/worker";

const STRANGER = "someone.else@example.net";
const MINUTE = 60_000;

async function pinOwner(sub = "sub-a", generation = 1) {
  await setOwner({ state: "pinned", generation, email: OWNER_EMAIL, google_sub: sub });
}

describe("first sign-in", () => {
  it("pins the first verified sign-in as OWNER_EMAIL and opens the page the owner asked for", async () => {
    const browser = new Browser();

    const asked = await browser.get("/accounts");
    expect(asked.status).toBe(302);
    expect(location(asked)).toBe("/signin?next=%2Faccounts");

    const page = await browser.get("/signin?next=%2Faccounts");
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(textOf(html)).toContain(SIGN_IN.title);
    expect(textOf(html)).toContain(SIGN_IN.line);
    const form = formsOf(html).find((f) => f.action === "/signin");
    expect(form?.method).toBe("post");
    expect(form?.buttons).toContain(SIGN_IN.button);
    expect(form?.fields.next).toBe("/accounts");

    const started = await browser.submit(html, "/signin");
    expect(started.status).toBe(302);
    const target = new URL(started.headers.get("Location") ?? "");
    expect(`${target.origin}${target.pathname}`).toBe(GOOGLE_AUTHORIZE);
    const params = target.searchParams;
    expect(params.get("client_id")).toBe("test-client-id.apps.googleusercontent.com");
    expect(params.get("redirect_uri")).toBe(`${ORIGIN}/google/callback`);
    expect(params.get("response_type")).toBe("code");
    expect(params.get("scope")).toBe("openid email");
    expect(params.get("prompt")).toBe("select_account");
    expect(params.get("code_challenge_method")).toBe("S256");
    expect(params.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(params.get("state")).toBeTruthy();
    expect(params.get("nonce")).toBeTruthy();
    expect(params.has("login_hint")).toBe(false);

    const flowCookies = setCookies(started);
    expect(flowCookies).toHaveLength(1);
    const [flow] = flowCookies;
    expect(flow?.name.startsWith("__Host-")).toBe(true);
    expect(flow?.name).not.toBe("__Host-session");
    expect(flow?.attributes).toMatchObject({
      httponly: true,
      secure: true,
      samesite: "lax",
      path: "/",
    });
    expect(flow?.attributes["max-age"]).toBe("600");
    expect(flow?.attributes.domain).toBeUndefined();

    const before = await dump();
    expect(before.owner).toEqual([
      { id: 1, state: "unpinned", generation: 1, email: null, google_sub: null },
    ]);

    const code = google.authorize(target, {
      email: OWNER_EMAIL,
      email_verified: true,
      sub: "sub-a",
    });
    const back = await browser.callback({ code, state: params.get("state") ?? "" });
    expect(back.status).toBe(302);
    expect(location(back)).toBe("/accounts");

    expect(await ownerRow()).toEqual({
      state: "pinned",
      generation: 1,
      email: OWNER_EMAIL,
      google_sub: "sub-a",
    });
    const cookies = setCookies(back);
    const session = cookies.find((c) => c.name === "__Host-session");
    expect(session?.attributes).toMatchObject({
      httponly: true,
      secure: true,
      samesite: "lax",
      path: "/",
    });
    expect(session?.attributes.domain).toBeUndefined();
    expect(session && clears(session)).toBe(false);
    const cleared = cookies.find((c) => c.name === flow?.name);
    expect(cleared && clears(cleared)).toBe(true);
    expect(browser.cookies.has(flow?.name ?? "")).toBe(false);

    const accounts = await browser.get("/accounts");
    expect(accounts.status).toBe(200);
    const frame = textOf(await accounts.text());
    expect(frame).toContain(PRODUCT);
    expect(frame).toContain(HOST);
    expect(frame).toContain("Accounts");
    expect(frame).toContain(OWNER_EMAIL);
  });

  it("accepts both issuer forms Google documents", async () => {
    for (const iss of ["https://accounts.google.com", "accounts.google.com"]) {
      const browser = new Browser();
      const response = await browser.signIn({ iss });
      expect(response.status, iss).toBe(302);
      expect(browser.session, iss).toBeDefined();
    }
  });
});

describe("someone who is not the owner", () => {
  it("shows another Google account the not-the-owner page and stores nothing", async () => {
    const browser = new Browser();
    const start = await browser.startSignIn("/connections");
    const before = await dump();

    const response = await browser.finishSignIn(start, { email: STRANGER, sub: "sub-x" });

    expect(response.status).toBe(403);
    const html = await response.text();
    expect(textOf(html)).toContain(NOT_OWNER.title);
    expect(textOf(html)).toContain(NOT_OWNER.line(STRANGER));
    expect(setCookies(response).some((c) => c.name === "__Host-session" && !clears(c))).toBe(false);
    expect(browser.session).toBeUndefined();
    expect(await dump()).toEqual(before);

    // "Use a different Google account" starts a new sign-in that returns where the first was going.
    const form = formsOf(html).find((f) => f.action === "/signin");
    expect(form?.buttons).toContain(NOT_OWNER.button);
    const again = await browser.submit(html, "/signin");
    expect(again.status).toBe(302);
    const retry = new URL(again.headers.get("Location") ?? "");
    expect(retry.searchParams.get("prompt")).toBe("select_account");
    const code = google.authorize(retry);
    const owner = await browser.callback({ code, state: retry.searchParams.get("state") ?? "" });
    expect(owner.status).toBe(302);
    expect(location(owner)).toBe("/connections");
  });

  it.each([
    ["false", { email_verified: false }],
    ["missing", { email_verified: undefined }],
  ])(
    "refuses the owner's address when Google reports email_verified %s",
    async (_label, claims) => {
      const browser = new Browser();
      const start = await browser.startSignIn();
      const before = await dump();

      const response = await browser.finishSignIn(start, claims);

      expect(response.status).toBe(403);
      expect(textOf(await response.text())).toContain(NOT_OWNER.line(OWNER_EMAIL));
      expect(browser.session).toBeUndefined();
      expect(await dump()).toEqual(before);
    },
  );

  it.each([
    ["an issuer other than Google", { iss: "https://evil.example" }],
    ["another audience", { aud: "another-client.apps.googleusercontent.com" }],
    ["an expired token", { exp: Math.floor(Date.now() / 1000) - 60 }],
    ["another nonce", { nonce: "not-the-nonce-of-this-sign-in" }],
    ["no subject", { sub: undefined }],
  ])("refuses an ID token with %s as not the owner", async (_label, claims) => {
    const browser = new Browser();
    const start = await browser.startSignIn();
    const before = await dump();

    const response = await browser.finishSignIn(start, claims);

    expect(response.status).toBe(403);
    const text = textOf(await response.text());
    expect(text).toContain(NOT_OWNER.title);
    expect(text).toContain(NOT_OWNER.line(OWNER_EMAIL));
    expect(browser.session).toBeUndefined();
    expect(await dump()).toEqual(before);
  });

  it("names no address when the ID token carries none", async () => {
    const browser = new Browser();
    const start = await browser.startSignIn();
    const before = await dump();

    const response = await browser.finishSignIn(start, { email: undefined });

    expect(response.status).toBe(403);
    const text = textOf(await response.text());
    expect(text).toContain(NOT_OWNER.title);
    expect(text).toContain(NOT_OWNER.unnamed);
    expect(text).not.toContain(OWNER_EMAIL);
    expect(await dump()).toEqual(before);
  });

  it("refuses the owner's address from a different Google account once one is pinned", async () => {
    await pinOwner("sub-a");
    const browser = new Browser();
    const start = await browser.startSignIn();
    const before = await dump();

    const response = await browser.finishSignIn(start, { sub: "sub-b" });

    expect(response.status).toBe(403);
    expect(textOf(await response.text())).toContain(NOT_OWNER.title);
    expect(browser.session).toBeUndefined();
    expect(await dump()).toEqual(before);
  });
});

describe("a callback that cannot finish", () => {
  async function expectDidntFinish(response: Response, before: Record<string, unknown[]>) {
    expect(response.status).toBe(400);
    const text = textOf(await response.text());
    expect(text).toContain(SIGN_IN.title);
    expect(text).toContain(DIDNT_FINISH.title);
    expect(text).toContain(DIDNT_FINISH.line);
    expect(setCookies(response).some((c) => c.name === "__Host-session" && !clears(c))).toBe(false);
    expect(await dump()).toEqual(before);
  }

  it("refuses a state that has no cookie in this browser, without calling Google", async () => {
    const other = new Browser();
    const start = await other.startSignIn();
    const code = google.authorize(start.authorizationUrl);
    const before = await dump();

    await expectDidntFinish(await new Browser().callback({ code, state: start.state }), before);
    await expectDidntFinish(
      await new Browser().callback({ code: "anything", state: "made-up" }),
      before,
    );
    await expectDidntFinish(await new Browser().callback({ code: "anything" }), before);
    expect(google.tokenRequests).toHaveLength(0);
  });

  it("refuses a state cookie older than ten minutes, even when the browser still sends it", async () => {
    const t0 = Date.now();
    vi.useFakeTimers({ toFake: ["Date"], now: t0 });
    const browser = new Browser();
    const start = await browser.startSignIn();
    const before = await dump();

    vi.setSystemTime(t0 + 10 * MINUTE + 1000);
    await expectDidntFinish(await browser.finishSignIn(start), before);
    expect(google.tokenRequests).toHaveLength(0);
  });

  it("refuses a state cookie made for another purpose", async () => {
    const browser = new Browser();
    const start = await browser.startSignIn();
    const name = [...browser.cookies.keys()].find(
      (n) => n.startsWith("__Host-") && n !== "__Host-session",
    );
    expect(name).toBeDefined();
    const flow = JSON.parse(fromBase64url(browser.cookies.get(name ?? "") ?? "")) as Record<
      string,
      unknown
    >;
    expect(flow.purpose).toBe("owner-sign-in");
    browser.cookies.set(name ?? "", base64url(JSON.stringify({ ...flow, purpose: "account" })));
    const before = await dump();

    await expectDidntFinish(await browser.finishSignIn(start), before);
    expect(google.tokenRequests).toHaveLength(0);
  });

  it("refuses a callback where Google reports the sign-in was cancelled", async () => {
    const browser = new Browser();
    const start = await browser.startSignIn();
    const before = await dump();

    await expectDidntFinish(
      await browser.callback({ error: "access_denied", state: start.state }),
      before,
    );
    expect(google.tokenRequests).toHaveLength(0);
  });

  it("refuses a replayed callback, even with the state cookie sent again", async () => {
    const browser = new Browser();
    const start = await browser.startSignIn();
    const [flowName, flowValue] = [...browser.cookies].find(([n]) => n !== "__Host-session") ?? [
      "",
      "",
    ];
    const code = google.authorize(start.authorizationUrl);

    const first = await browser.callback({ code, state: start.state });
    expect(first.status).toBe(302);
    const afterFirst = await dump();

    await expectDidntFinish(await browser.callback({ code, state: start.state }), afterFirst);

    const replay = new Browser();
    replay.cookies.set(flowName, flowValue);
    await expectDidntFinish(await replay.callback({ code, state: start.state }), afterFirst);
    expect(google.tokenRequests).toHaveLength(2);
    expect(await sessions()).toHaveLength(1);
  });

  it.each(["5xx", "429"] as const)(
    "says Google didn't answer when its token endpoint answers %s",
    async (mode) => {
      const browser = new Browser();
      const start = await browser.startSignIn();
      const before = await dump();
      google.mode = mode;

      const response = await browser.finishSignIn(start);

      expect(response.status).toBe(502);
      const text = textOf(await response.text());
      expect(text).toContain(SIGN_IN.title);
      expect(text).toContain(GOOGLE_DOWN.title);
      expect(text).toContain(GOOGLE_DOWN.line);
      expect(browser.session).toBeUndefined();
      expect(await dump()).toEqual(before);
    },
  );

  it("says Google didn't answer when its token endpoint takes more than ten seconds", async () => {
    const browser = new Browser();
    const start = await browser.startSignIn();
    const before = await dump();
    google.mode = "slow";
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const pending = browser.finishSignIn(start);
    await vi.waitFor(() => expect(google.tokenRequests).toHaveLength(1), {
      interval: 1,
      timeout: 5000,
    });
    await vi.advanceTimersByTimeAsync(10_000);
    const response = await pending;

    expect(response.status).toBe(502);
    expect(textOf(await response.text())).toContain(GOOGLE_DOWN.title);
    expect(browser.session).toBeUndefined();
    expect(await dump()).toEqual(before);
  });
});

describe("what an anonymous visitor can learn or change", () => {
  it("stores nothing and never reveals the owner's address", async () => {
    await pinOwner("sub-a");
    const before = await dump();
    const responses: Array<{ label: string; response: Response; claimed?: string }> = [];
    const record = (label: string, response: Response, claimed?: string) =>
      responses.push({ label, response, claimed });

    const visitor = new Browser();
    record("GET /", await visitor.get("/"));
    record("GET /accounts", await visitor.get("/accounts"));
    record("GET /signin", await visitor.get("/signin"));
    record("GET /signin?next", await visitor.get("/signin?next=%2Fconnections"));
    const start = await visitor.startSignIn("/accounts");
    record("POST /signin", start.response);
    expect(start.authorizationUrl.searchParams.has("login_hint")).toBe(false);

    const attempt = async (label: string, claims: Record<string, unknown>, claimed?: string) => {
      const browser = new Browser();
      record(label, await browser.finishSignIn(await browser.startSignIn(), claims), claimed);
    };
    await attempt("another address", { email: STRANGER, sub: "sub-x" }, STRANGER);
    await attempt("unverified owner address", { email_verified: false, sub: "sub-x" }, OWNER_EMAIL);
    await attempt("bad issuer", { iss: "https://evil.example", email: STRANGER }, STRANGER);
    await attempt("owner address, other account", { sub: "sub-b" }, OWNER_EMAIL);
    record("unknown state", await new Browser().callback({ code: "x", state: "y" }));
    record("cancelled", await visitor.callback({ error: "access_denied", state: start.state }));
    const replayed = new Browser();
    const replayStart = await replayed.startSignIn();
    const usedCode = google.authorize(replayStart.authorizationUrl, {
      email: STRANGER,
      sub: "sub-x",
    });
    record(
      "first use",
      await replayed.callback({ code: usedCode, state: replayStart.state }),
      STRANGER,
    );
    record("replay", await replayed.callback({ code: usedCode, state: replayStart.state }));
    google.mode = "5xx";
    await attempt("Google down", {});

    expect(await dump()).toEqual(before);
    for (const { label, response, claimed } of responses) {
      const exposed = [
        await response.text(),
        response.headers.get("Location") ?? "",
        ...response.headers.getSetCookie(),
      ];
      if (claimed !== OWNER_EMAIL) {
        expect(exposed.join("\n"), label).not.toContain(OWNER_EMAIL);
        expect(exposed.join("\n"), label).not.toContain(encodeURIComponent(OWNER_EMAIL));
      }
    }
  });
});

describe("the return path after sign-in", () => {
  it.each([
    ["/accounts?x=1", "/accounts?x=1"],
    ["https://evil.example/", "/accounts"],
    ["//evil.example/", "/accounts"],
    ["/\\evil.example", "/accounts"],
    ["javascript:alert(1)", "/accounts"],
    ["", "/accounts"],
    [undefined, "/accounts"],
  ])("returns from next=%j to %s", async (next, expected) => {
    const browser = new Browser();
    const response = await browser.signIn({}, next);
    expect(response.status).toBe(302);
    expect(location(response)).toBe(expected);
  });
});

describe("a returning owner", () => {
  it("gets a new session without changing the stored owner", async () => {
    await pinOwner("sub-a");
    const before = await ownerRow();
    const browser = new Browser();
    await browser.signInAsOwner({ sub: "sub-a" });
    expect((await browser.post("/signout")).status).toBe(302);
    expect(browser.session).toBeUndefined();

    await browser.signInAsOwner({ sub: "sub-a" });

    expect(await ownerRow()).toEqual(before);
    expect(await sessions()).toHaveLength(1);
    expect((await browser.get("/accounts")).status).toBe(200);
  });

  it("skips Google when already signed in", async () => {
    const browser = new Browser();
    await browser.signInAsOwner();

    const signin = await browser.get("/signin?next=%2Fconnections");
    expect(signin.status).toBe(302);
    expect(location(signin)).toBe("/connections");
    const plain = await browser.get("/signin");
    expect(location(plain)).toBe("/accounts");
    const root = await browser.get("/");
    expect(root.status).toBe(302);
    expect(location(root)).toBe("/accounts");
  });
});

import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { resetPlan } from "../src/owner/reset";
import { Browser, setCookies, type SignInStart } from "./support/browser";
import { DIDNT_FINISH, GOOGLE_DOWN, NOT_OWNER, UNAVAILABLE } from "./support/copy";
import { dump, insertSession, ownerRow, writeRecordingDb } from "./support/db";
import { base64url, fromBase64url, google, type Claims } from "./support/google";
import { location, testEnv, textOf } from "./support/worker";

const DAY = 86_400_000;

function tamperFlow(browser: Browser, start: SignInStart, changes: Record<string, unknown>) {
  const name = `__Host-g-${start.state}`;
  const raw = browser.cookies.get(name);
  expect(raw).toBeDefined();
  const flow = JSON.parse(fromBase64url(raw!)) as Record<string, unknown>;
  browser.cookies.set(name, base64url(JSON.stringify({ ...flow, ...changes })));
}

async function seedExpiredSession(generation: number) {
  await insertSession({
    token_hash: "expired-session",
    generation,
    created_at: Date.now() - 31 * DAY,
    last_used_at: Date.now() - 8 * DAY,
  });
}

function expectNoSessionCookie(response: Response) {
  expect(setCookies(response).filter((cookie) => cookie.name === "__Host-session")).toEqual([]);
}

describe("sign-in callback guards", () => {
  it("refuses an empty Google subject without issuing a session or changing data", async () => {
    const browser = new Browser();
    const start = await browser.startSignIn();
    const before = await dump();

    const response = await browser.finishSignIn(start, { sub: "" });

    expect(response.status).toBe(403);
    expect(textOf(await response.text())).toContain(NOT_OWNER.title);
    expectNoSessionCookie(response);
    expect(browser.session).toBeUndefined();
    expect(await dump()).toEqual(before);
  });

  it("treats a cancellation as failed even when Google also sends a valid code", async () => {
    const browser = new Browser();
    const start = await browser.startSignIn();
    const code = google.authorize(start.authorizationUrl);
    const before = await dump();

    const response = await browser.callback({ code, state: start.state, error: "access_denied" });

    expect(response.status).toBe(400);
    expect(textOf(await response.text())).toContain(DIDNT_FINISH.title);
    expect(google.tokenRequests).toEqual([]);
    expectNoSessionCookie(response);
    expect(await dump()).toEqual(before);
  });

  it("refuses a flow created in the future before contacting Google", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
    const browser = new Browser();
    const start = await browser.startSignIn();
    tamperFlow(browser, start, { createdAt: Date.now() + 60_000 });
    const before = await dump();

    const response = await browser.finishSignIn(start);

    expect(response.status).toBe(400);
    expect(textOf(await response.text())).toContain(DIDNT_FINISH.title);
    expect(google.tokenRequests).toEqual([]);
    expectNoSessionCookie(response);
    expect(await dump()).toEqual(before);
  });

  it.each(["https://evil.example/", "//evil.example/", "/\\evil.example"])(
    "returns to accounts when the flow cookie's return path is changed to %s",
    async (next) => {
      const browser = new Browser();
      const start = await browser.startSignIn("/connections");
      tamperFlow(browser, start, { next });

      const response = await browser.finishSignIn(start);

      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toBe("/accounts");
      expect(browser.session).toBeDefined();
    },
  );

  it("sets the session cookie to last thirty days", async () => {
    const response = await new Browser().signIn();
    expect(response.status).toBe(302);
    const cookie = setCookies(response).find((item) => item.name === "__Host-session");
    expect(cookie).toBeDefined();
    expect(cookie?.attributes["max-age"]).toBe("2592000");
  });

  it("keeps expired sessions when a different Google subject is refused", async () => {
    await new Browser().signInAsOwner({ sub: "sub-a" });
    await seedExpiredSession(1);
    const browser = new Browser();
    const start = await browser.startSignIn();
    const before = await dump();

    const response = await browser.finishSignIn(start, { sub: "sub-b" });

    expect(response.status).toBe(403);
    expect(textOf(await response.text())).toContain(NOT_OWNER.title);
    expectNoSessionCookie(response);
    expect(await dump()).toEqual(before);
  });

  it("keeps expired sessions when a sign-in begun before a reset is refused", async () => {
    const browser = new Browser();
    const start = await browser.startSignIn();
    const plan = resetPlan({ state: "unpinned", generation: 1 }, Date.now());
    await env.DB.batch(plan.statements.map((sql) => env.DB.prepare(sql)));
    await seedExpiredSession(2);
    const before = await dump();

    const response = await browser.finishSignIn(start);

    expect(response.status).toBe(400);
    expect(textOf(await response.text())).toContain(DIDNT_FINISH.title);
    expectNoSessionCookie(response);
    expect(await dump()).toEqual(before);
  });

  it("rolls back the first owner pin when inserting its session fails", async () => {
    await env.DB.prepare(
      "CREATE TRIGGER fail_session_insert BEFORE INSERT ON owner_sessions BEGIN SELECT RAISE(ABORT, 'test'); END",
    ).run();
    try {
      const browser = new Browser();
      const start = await browser.startSignIn();
      const before = await dump();

      const response = await browser.finishSignIn(start);

      expect(response.status).toBe(503);
      expect(textOf(await response.text())).toContain(UNAVAILABLE.title);
      expect(location(response)).toBeNull();
      expectNoSessionCookie(response);
      expect(await ownerRow()).toMatchObject({ state: "unpinned", email: null, google_sub: null });
      expect(await dump()).toEqual(before);
    } finally {
      await env.DB.prepare("DROP TRIGGER fail_session_insert").run();
    }
  });
});

const refusedClaims: Array<[string, Claims]> = [
  ["another email", { email: "someone.else@example.com" }],
  ["an unverified email", { email_verified: false }],
  ["a wrong issuer", { iss: "https://evil.example" }],
  ["a wrong audience", { aud: "another-client" }],
  ["a wrong nonce", { nonce: "wrong-nonce" }],
  ["an expired token", { exp: 1 }],
  ["a missing subject", { sub: undefined }],
  ["an empty subject", { sub: "" }],
];

describe("requests before owner verification", () => {
  it.each(refusedClaims)("attempts no writes for %s", async (_label, claims) => {
    const watched = writeRecordingDb();
    const browser = new Browser(() => testEnv({ DB: watched.db }));
    const start = await browser.startSignIn();
    const before = await dump();

    const response = await browser.finishSignIn(start, claims);

    expect(response.status).toBe(403);
    expect(textOf(await response.text())).toContain(NOT_OWNER.title);
    expect(watched.writes).toEqual([]);
    expect(await dump()).toEqual(before);
  });

  it("attempts no writes for a different subject after the owner is pinned", async () => {
    await new Browser().signInAsOwner();
    const watched = writeRecordingDb();
    const browser = new Browser(() => testEnv({ DB: watched.db }));
    const before = await dump();

    const response = await browser.signIn({ sub: "sub-b" });

    expect(response.status).toBe(403);
    expect(watched.writes).toEqual([]);
    expect(await dump()).toEqual(before);
  });

  it("attempts no writes when Google is unavailable", async () => {
    const watched = writeRecordingDb();
    const browser = new Browser(() => testEnv({ DB: watched.db }));
    const start = await browser.startSignIn();
    const before = await dump();
    google.mode = "5xx";

    const response = await browser.finishSignIn(start);

    expect(response.status).toBe(502);
    expect(textOf(await response.text())).toContain(GOOGLE_DOWN.title);
    expect(watched.writes).toEqual([]);
    expect(await dump()).toEqual(before);
  });

  it.each(["a cancellation", "an unknown state"])("attempts no writes for %s", async (kind) => {
    const watched = writeRecordingDb();
    const browser = new Browser(() => testEnv({ DB: watched.db }));
    const start = await browser.startSignIn();
    const before = await dump();
    const code = google.authorize(start.authorizationUrl);

    const response = await browser.callback({
      code,
      state: kind === "an unknown state" ? "unknown-state" : start.state,
      ...(kind === "a cancellation" ? { error: "access_denied" } : {}),
    });

    expect(response.status).toBe(400);
    expect(watched.writes).toEqual([]);
    expect(google.tokenRequests).toEqual([]);
    expect(await dump()).toEqual(before);
  });

  it("attempts no writes for anonymous page reads and posts", async () => {
    const watched = writeRecordingDb();
    const browser = new Browser(() => testEnv({ DB: watched.db }));
    const before = await dump();
    for (const method of ["GET", "POST"]) {
      for (const path of [
        "/",
        "/accounts",
        "/connections",
        "/signin",
        "/signout",
        "/signout/all",
      ]) {
        await browser.request(path, { method });
        expect(watched.writes, `${method} ${path}`).toEqual([]);
        expect(await dump(), `${method} ${path}`).toEqual(before);
      }
    }
    expect(google.tokenRequests).toEqual([]);
  });
});

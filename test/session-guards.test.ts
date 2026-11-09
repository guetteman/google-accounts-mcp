import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { Browser, setCookies } from "./support/browser";
import { SIGN_IN, UNAVAILABLE } from "./support/copy";
import { dump, statementFailingDb } from "./support/db";
import { location, testEnv, textOf } from "./support/worker";

const DAY = 86_400_000;

async function sessionWithTimes(createdAt: number, lastUsedAt: number) {
  const browser = new Browser();
  await browser.signInAsOwner();
  await env.DB.prepare("UPDATE owner_sessions SET created_at = ?, last_used_at = ?")
    .bind(createdAt, lastUsedAt)
    .run();
  return browser;
}

describe("origins of methods that can change data", () => {
  it.each(["DELETE", "PUT", "PATCH"])(
    "refuses %s from a foreign or missing origin before touching a valid session",
    async (method) => {
      const browser = new Browser();
      await browser.signInAsOwner();
      for (const path of ["/signout", "/accounts"]) {
        for (const origin of [null, "https://evil.example"]) {
          const before = await dump();
          const response = await browser.request(path, { method, origin });
          expect(response.status, `${path} from ${origin}`).toBe(403);
          expect(location(response)).toBeNull();
          expect(await dump()).toEqual(before);
        }
      }
    },
  );
});

describe("expired sessions on owner actions", () => {
  it.each(["idle", "absolute"])(
    "refuses sign-out posts after the %s limit without changing data",
    async (limit) => {
      const now = Date.now();
      vi.useFakeTimers({ toFake: ["Date"], now });
      const browser = await sessionWithTimes(
        limit === "absolute" ? now - 30 * DAY - 60_000 : now - 8 * DAY,
        limit === "idle" ? now - 7 * DAY - 60_000 : now - 60_000,
      );
      const token = browser.session;
      const before = await dump();

      for (const path of ["/signout", "/signout/all"]) {
        const response = await browser.post(path);
        expect(response.status, path).toBe(401);
        expect(textOf(await response.text())).toContain(SIGN_IN.title);
        expect(location(response)).toBeNull();
        expect(setCookies(response).filter((cookie) => cookie.name === "__Host-session")).toEqual(
          [],
        );
        expect(browser.session).toBe(token);
        expect(await dump()).toEqual(before);
      }
    },
  );
});

describe("session expiry boundaries", () => {
  it.each([
    ["expires at exactly seven days without use", 8 * DAY, 7 * DAY, 302],
    ["works one millisecond before seven days without use", 8 * DAY, 7 * DAY - 1, 200],
    ["expires at exactly thirty days after sign-in", 30 * DAY, 60_000, 302],
    ["works one millisecond before thirty days after sign-in", 30 * DAY - 1, 60_000, 200],
  ])("%s", async (_label, age, idle, status) => {
    const now = Date.now();
    vi.useFakeTimers({ toFake: ["Date"], now });
    const browser = await sessionWithTimes(now - age, now - idle);

    const response = await browser.get("/accounts");

    expect(response.status).toBe(status);
    if (status === 302) expect(location(response)).toBe("/signin?next=%2Faccounts");
    else expect(location(response)).toBeNull();
  });
});

async function expectDatabaseFailure(
  response: Response,
  browser: Browser,
  token: string | undefined,
) {
  expect(response.status).toBe(503);
  expect(textOf(await response.text())).toContain(UNAVAILABLE.title);
  expect(location(response)).toBeNull();
  expect(setCookies(response).filter((cookie) => cookie.name === "__Host-session")).toEqual([]);
  expect(browser.session).toBe(token);
}

describe("database failures after the owner gate", () => {
  it("shows a database error when touching the session fails on a page or sign-out", async () => {
    const browser = new Browser();
    await browser.signInAsOwner();
    const token = browser.session;
    const before = await dump();
    const workerEnv = testEnv({ DB: statementFailingDb(/^\s*UPDATE owner_sessions\b/i) });

    for (const response of [
      await browser.get("/accounts", { env: workerEnv }),
      await browser.post("/signout", {}, { env: workerEnv }),
    ]) {
      await expectDatabaseFailure(response, browser, token);
      expect(await dump()).toEqual(before);
    }
    expect((await browser.get("/accounts")).status).toBe(200);
  });

  it.each(["/signout", "/signout/all"])(
    "keeps the cookie and sessions when deleting sessions fails at %s",
    async (path) => {
      const now = Date.now();
      vi.useFakeTimers({ toFake: ["Date"], now });
      const browser = await sessionWithTimes(now - 60_000, now - 60_000);
      const token = browser.session;
      const workerEnv = testEnv({ DB: statementFailingDb(/^\s*DELETE FROM owner_sessions\b/i) });

      const response = await browser.post(path, {}, { env: workerEnv });

      await expectDatabaseFailure(response, browser, token);
      const rows = await env.DB.prepare("SELECT last_used_at FROM owner_sessions").all<{
        last_used_at: number;
      }>();
      expect(rows.results).toEqual([{ last_used_at: now }]);
      expect((await browser.get("/accounts")).status).toBe(200);
    },
  );
});

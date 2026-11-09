import { describe, expect, it, vi } from "vite-plus/test";
import { Browser, clears, setCookies } from "./support/browser";
import { SIGN_IN } from "./support/copy";
import { dump, sessions, sha256Hex } from "./support/db";
import { location, textOf } from "./support/worker";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

describe("owner pages without a session", () => {
  it("send a GET to sign-in and refuse a POST, whatever else the request carries", async () => {
    const owner = new Browser();
    await owner.signInAsOwner();
    const token = owner.session ?? "";

    const visitors: Array<[string, Browser, Record<string, string>]> = [
      ["no cookie", new Browser(), {}],
      ["an unknown token", withCookie("__Host-session", "A".repeat(43)), {}],
      ["the owner's token as a bearer token", new Browser(), { Authorization: `Bearer ${token}` }],
      ["the owner's token in a cookie of another name", withCookie("session", token), {}],
    ];
    for (const [label, visitor, headers] of visitors) {
      for (const path of ["/accounts", "/connections"]) {
        const response = await visitor.get(path, { headers });
        expect(response.status, `${label}: GET ${path}`).toBe(302);
        expect(location(response), `${label}: GET ${path}`).toBe(
          `/signin?next=${encodeURIComponent(path)}`,
        );
      }
      for (const path of ["/signout", "/signout/all"]) {
        const before = await dump();
        const response = await visitor.post(path, {}, { headers });
        expect(response.status, `${label}: POST ${path}`).toBe(401);
        expect(textOf(await response.text()), `${label}: POST ${path}`).toContain(SIGN_IN.title);
        expect(await dump(), `${label}: POST ${path}`).toEqual(before);
      }
    }
    expect((await owner.get("/accounts")).status).toBe(200);
  });
});

describe("posts from another site", () => {
  it("are refused unless they carry this deploy's Origin", async () => {
    const owner = new Browser();
    await owner.signInAsOwner();
    const before = await dump();

    for (const origin of ["https://evil.example", null]) {
      for (const path of ["/signout", "/signout/all", "/signin"]) {
        const response = await owner.post(path, {}, { origin });
        expect(response.status, `${path} from ${origin}`).toBe(403);
        expect(location(response), `${path} from ${origin}`).toBeNull();
      }
    }
    expect(await dump()).toEqual(before);
    expect((await owner.get("/accounts")).status).toBe(200);

    const response = await owner.post("/signout");
    expect(response.status).toBe(302);
    expect(location(response)).toBe("/signin");
  });
});

describe("session lifetime", () => {
  it("ends seven days after the last use, and each use restarts that clock", async () => {
    const t0 = Date.now();
    vi.useFakeTimers({ toFake: ["Date"], now: t0 });
    const browser = new Browser();
    await browser.signInAsOwner();

    vi.setSystemTime(t0 + 7 * DAY - MINUTE);
    expect((await browser.get("/accounts")).status).toBe(200);
    vi.setSystemTime(t0 + 2 * (7 * DAY - MINUTE));
    expect((await browser.get("/accounts")).status).toBe(200);

    vi.setSystemTime(t0 + 2 * (7 * DAY - MINUTE) + 7 * DAY + MINUTE);
    const response = await browser.get("/accounts");
    expect(response.status).toBe(302);
    expect(location(response)).toBe("/signin?next=%2Faccounts");
  });

  it("ends thirty days after sign-in, however often it is used", async () => {
    const t0 = Date.now();
    vi.useFakeTimers({ toFake: ["Date"], now: t0 });
    const browser = new Browser();
    await browser.signInAsOwner();

    for (let day = 1; day < 30; day++) {
      vi.setSystemTime(t0 + day * DAY);
      expect((await browser.get("/accounts")).status, `day ${day}`).toBe(200);
    }
    vi.setSystemTime(t0 + 30 * DAY - MINUTE);
    expect((await browser.get("/accounts")).status).toBe(200);

    vi.setSystemTime(t0 + 30 * DAY + MINUTE);
    const response = await browser.get("/accounts");
    expect(response.status).toBe(302);
    expect(location(response)).toBe("/signin?next=%2Faccounts");
  });
});

describe("signing out", () => {
  it("ends only this browser's session, and every session from any device", async () => {
    const phone = new Browser();
    const laptop = new Browser();
    await phone.signInAsOwner();
    await laptop.signInAsOwner();
    expect(await sessions()).toHaveLength(2);
    const laptopBefore = laptop.session ?? "";

    const out = await laptop.post("/signout");
    expect(out.status).toBe(302);
    expect(location(out)).toBe("/signin");
    expect(setCookies(out).some((c) => c.name === "__Host-session" && clears(c))).toBe(true);
    const replayed = await new Browser().get("/accounts", {
      headers: { Cookie: `__Host-session=${laptopBefore}` },
    });
    expect(replayed.status).toBe(302);
    expect((await phone.get("/accounts")).status).toBe(200);
    expect(await sessions()).toHaveLength(1);

    await laptop.signInAsOwner();
    const phoneToken = phone.session ?? "";
    const laptopTokenNow = laptop.session ?? "";
    const all = await phone.post("/signout/all");
    expect(all.status).toBe(302);
    expect(location(all)).toBe("/signin");
    expect(await sessions()).toHaveLength(0);
    for (const token of [phoneToken, laptopTokenNow]) {
      const response = await new Browser().get("/accounts", {
        headers: { Cookie: `__Host-session=${token}` },
      });
      expect(response.status).toBe(302);
    }
  });
});

describe("what the database holds", () => {
  it("keeps only a SHA-256 of the session token, which does not work as a cookie", async () => {
    const browser = new Browser();
    await browser.signInAsOwner();
    const token = browser.session ?? "";
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const rows = await sessions();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.token_hash).toBe(await sha256Hex(token));
    expect(JSON.stringify(await dump())).not.toContain(token);

    const forged = withCookie("__Host-session", rows[0]?.token_hash ?? "");
    const response = await forged.get("/accounts");
    expect(response.status).toBe(302);
    expect(location(response)).toBe("/signin?next=%2Faccounts");
  });
});

function withCookie(name: string, value: string): Browser {
  const browser = new Browser();
  browser.cookies.set(name, value);
  return browser;
}

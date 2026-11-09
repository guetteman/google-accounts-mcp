import { describe, expect, it, vi } from "vite-plus/test";
import { http, HttpResponse } from "msw";
import { access, accessJwks, ROTATED_KEY_ID, signAccessJwt, type Claims } from "./support/access";
import { Browser } from "./support/browser";
import { ACCESS_REFUSED, ACCESS_UNAVAILABLE, NOT_OWNER, PRODUCT } from "./support/copy";
import { dump, ownerRow, setOwner, writeRecordingDb } from "./support/db";
import { prepareWrites, WRITE_PATH } from "./support/page-app";
import { network } from "./support/network";
import { HOST, location, OWNER_EMAIL, testEnv, textOf } from "./support/worker";

const STRANGER = "someone.else@example.net";

describe("Access owner check", () => {
  it("pins the first verified owner by email and opens the frame without setting cookies", async () => {
    expect(await ownerRow()).toEqual({ state: "unpinned", generation: 1, email: null });
    const owner = new Browser();
    await owner.authenticate();
    const response = await owner.get("/accounts");
    expect(response.status).toBe(200);
    const text = textOf(await response.text());
    for (const value of [PRODUCT, HOST, "Accounts", OWNER_EMAIL]) expect(text).toContain(value);
    expect(await ownerRow()).toEqual({ state: "pinned", generation: 1, email: OWNER_EMAIL });
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(access.requests.map((r) => r.url)).toEqual([
      `${testEnv().ACCESS_ISSUER}/cdn-cgi/access/certs`,
    ]);
  });

  it.each([false, true])(
    "refuses another verified address without revealing or changing the owner when pinned is %s",
    async (pinned) => {
      if (pinned) await setOwner({ state: "pinned", generation: 1, email: OWNER_EMAIL });
      const before = await dump();
      const browser = new Browser();
      await browser.authenticate({ email: STRANGER });
      const response = await browser.get("/accounts");
      expect(response.status).toBe(403);
      const html = await response.text();
      const text = textOf(html);
      expect(text).toContain(NOT_OWNER.title);
      expect(text).toContain(STRANGER);
      expect(text).toContain(NOT_OWNER.button);
      expect(html).toMatch(/<a\b[^>]*href="\/cdn-cgi\/access\/logout"/);
      expect(html).not.toContain(OWNER_EMAIL);
      expect(await dump()).toEqual(before);
    },
  );

  it.each(["no credentials", "a bearer token", "an Access cookie", "an old owner session cookie"])(
    "refuses %s without fetching keys or changing data",
    async (kind) => {
      const token = await signAccessJwt();
      const headers: Record<string, string> =
        kind === "a bearer token"
          ? { Authorization: `Bearer ${token}` }
          : kind === "an Access cookie"
            ? { Cookie: `CF_Authorization=${token}` }
            : kind === "an old owner session cookie"
              ? { Cookie: `__Host-session=${token}` }
              : {};
      const before = await dump();
      const response = await new Browser().get("/accounts", { headers });
      expect(response.status).toBe(403);
      const text = textOf(await response.text());
      expect(text).toContain(ACCESS_REFUSED.title);
      expect(text).toContain(ACCESS_REFUSED.line);
      expect(text).not.toContain(OWNER_EMAIL);
      expect(await dump()).toEqual(before);
      expect(access.requests).toEqual([]);
    },
  );

  it.each([
    ["malformed token", {}, { malformed: true }],
    ["a foreign signature with a known key id", {}, { foreign: true }],
    ["an unknown key", {}, { kid: "unknown", foreign: true }],
    ["no signature", {}, { alg: "none" }],
    ["a symmetric signature", {}, { alg: "HS256" }],
    ["another RSA algorithm", {}, { alg: "RS512" }],
    ["another issuer", { iss: "https://evil.example" }, {}],
    ["an issuer with a trailing slash", { issuerSlash: true }, {}],
    ["another audience", { aud: ["b".repeat(64)] }, {}],
    ["an expired assertion", { exp: 1 }, {}],
    ["an assertion not valid yet", { nbf: 9_000_000_000 }, {}],
    ["no email", { email: undefined }, {}],
    ["an empty email", { email: " " }, {}],
    ["an invalid email", { email: "not-an-email" }, {}],
    ["no expiration", { exp: undefined }, {}],
    ["no not-before claim", { nbf: undefined }, {}],
  ] as Array<
    [string, Claims, { malformed?: boolean; foreign?: boolean; kid?: string; alg?: string }]
  >)("rejects %s without writing or exposing the owner", async (_label, claims, header) => {
    const watched = writeRecordingDb();
    const before = await dump();
    if (header.alg === "RS512") access.keyAlgorithm = "RS512";
    const token = header.malformed
      ? "not.a.jwt"
      : await signAccessJwt(
          { ...claims, ...(claims.issuerSlash ? { iss: `${testEnv().ACCESS_ISSUER}/` } : {}) },
          header,
        );
    const response = await new Browser().get("/accounts", {
      headers: { "Cf-Access-Jwt-Assertion": token },
      env: testEnv({ DB: watched.db }),
    });
    expect(response.status).toBe(403);
    const html = await response.text();
    expect(textOf(html)).toContain(ACCESS_REFUSED.title);
    expect(html).not.toContain(OWNER_EMAIL);
    expect(watched.writes).toEqual([]);
    expect(await dump()).toEqual(before);
  });

  it("accepts audience membership and compares emails after trimming and lower-casing", async () => {
    const owner = new Browser();
    await owner.authenticate({
      email: "  Alex.Personal@Example.COM  ",
      aud: ["another-app", testEnv().ACCESS_AUDIENCE],
    });
    expect((await owner.get("/accounts")).status).toBe(200);
    expect(await ownerRow()).toEqual({ state: "pinned", generation: 1, email: OWNER_EMAIL });
  });

  it("opens both owner pages and redirects the root without changing the pinned row", async () => {
    await setOwner({ state: "pinned", generation: 4, email: OWNER_EMAIL });
    const before = await dump();
    const owner = new Browser();
    await owner.authenticate();
    for (const path of ["/accounts", "/connections"])
      expect((await owner.get(path)).status, path).toBe(200);
    const root = await owner.get("/");
    expect(root.status).toBe(302);
    expect(location(root)).toBe("/accounts");
    expect(await dump()).toEqual(before);
  });

  it("refuses strangers at the root in the same way as at Accounts", async () => {
    for (const assertion of [undefined, "bad", await signAccessJwt({ email: STRANGER })]) {
      const browser = new Browser();
      browser.assertion = assertion;
      const response = await browser.get("/");
      expect(response.status).toBe(403);
      expect(textOf(await response.text())).toContain(
        assertion?.includes(".") ? NOT_OWNER.title : ACCESS_REFUSED.title,
      );
      expect(location(response)).toBeNull();
    }
    access.mode = "fail";
    const browser = new Browser(() =>
      testEnv({ ACCESS_ISSUER: "https://root-failure.cloudflareaccess.com" }),
    );
    browser.assertion = await signAccessJwt({ iss: "https://root-failure.cloudflareaccess.com" });
    expect((await browser.get("/")).status).toBe(503);
  });

  it.each(["missing", "invalid", "another address"])(
    "attempts no writes and reveals no owner on any owner route with %s identity",
    async (kind) => {
      await prepareWrites();
      const watched = writeRecordingDb();
      const browser = new Browser(() => testEnv({ DB: watched.db }));
      browser.assertion =
        kind === "missing"
          ? undefined
          : kind === "invalid"
            ? "bad"
            : await signAccessJwt({ email: STRANGER });
      const before = await dump();
      for (const path of ["/", "/accounts", "/connections", "/authorize", WRITE_PATH]) {
        const response = path === WRITE_PATH ? await browser.post(path) : await browser.get(path);
        expect(response.status, path).toBe(path === "/authorize" ? 404 : 403);
        expect(`${await response.text()}${location(response) ?? ""}`, path).not.toContain(
          OWNER_EMAIL,
        );
        expect(watched.writes, path).toEqual([]);
        expect(await dump(), path).toEqual(before);
      }
    },
  );
});

describe("Access signing keys", () => {
  it.each([
    ["a non-RSA key", { kty: "EC" }],
    ["an encryption key", { use: "enc" }],
    ["an incompatible algorithm", { alg: "RS512" }],
    ["an empty key ID", { kid: "" }],
    ["a missing key ID", { kid: undefined }],
    ["an empty modulus", { n: "" }],
    ["a missing modulus", { n: undefined }],
    ["an empty exponent", { e: "" }],
    ["a missing exponent", { e: undefined }],
  ])("refuses %s alone or beside a valid key and recovers after repair", async (_label, fields) => {
    const { keys } = await accessJwks();
    const invalid = { ...keys[0], ...fields };
    let body = { keys: [invalid] };
    const certs = vi.fn(() => HttpResponse.json(body));
    network.use(http.get(`${testEnv().ACCESS_ISSUER}/cdn-cgi/access/certs`, certs));
    const owner = new Browser();
    await owner.authenticate();
    const before = await dump();

    const alone = await owner.get("/accounts");
    expect(alone.status).toBe(503);
    expect(textOf(await alone.text())).toContain(ACCESS_UNAVAILABLE.title);
    expect(await dump()).toEqual(before);

    body = { keys: [...keys, { ...invalid, kid: "unusable-spare", ...fields }] };
    const besideValid = await owner.get("/accounts");
    expect(besideValid.status).toBe(503);
    expect(textOf(await besideValid.text())).toContain(ACCESS_UNAVAILABLE.title);
    expect(await dump()).toEqual(before);

    body = { keys };
    expect((await owner.get("/accounts")).status).toBe(200);
    expect(certs).toHaveBeenCalledTimes(3);
  });

  it("accepts signing RSA keys without optional use or alg metadata", async () => {
    const { keys } = await accessJwks();
    network.use(
      http.get(`${testEnv().ACCESS_ISSUER}/cdn-cgi/access/certs`, () =>
        HttpResponse.json({ keys: keys.map(({ use: _use, alg: _alg, ...key }) => key) }),
      ),
    );
    const owner = new Browser();
    await owner.authenticate();
    expect((await owner.get("/accounts")).status).toBe(200);
  });

  it.each([
    "fail",
    "junk",
    "invalid-key",
    "weak-key",
    "no-kty",
    "short-key",
    "invalid-json",
    "redirect",
  ] as const)("shows an Access outage for %s certs and changes nothing", async (mode) => {
    access.mode = mode;
    const browser = new Browser();
    await browser.authenticate();
    const before = await dump();
    const response = await browser.get("/accounts");
    expect(response.status).toBe(503);
    const text = textOf(await response.text());
    expect(text).toContain(ACCESS_UNAVAILABLE.title);
    expect(text).toContain(ACCESS_UNAVAILABLE.line);
    expect(text).not.toContain(OWNER_EMAIL);
    expect(await dump()).toEqual(before);
  });

  it.each(["invalid-key", "weak-key", "no-kty", "short-key"] as const)(
    "recovers on the next request after the certs endpoint returns an unusable key (%s)",
    async (mode) => {
      access.mode = mode;
      const owner = new Browser();
      await owner.authenticate();
      expect((await owner.get("/accounts")).status).toBe(503);
      access.mode = "ok";
      expect((await owner.get("/accounts")).status).toBe(200);
      expect(access.requests).toHaveLength(2);
    },
  );

  it("fetches the certs once when a cold isolate meets an unknown key", async () => {
    const browser = new Browser();
    browser.assertion = await signAccessJwt({}, { kid: "unknown", foreign: true });
    expect((await browser.get("/accounts")).status).toBe(403);
    expect(access.requests).toHaveLength(1);
  });

  it("aborts a slow cert fetch after a bounded wait and leaves D1 unchanged", async () => {
    access.mode = "slow";
    const browser = new Browser();
    await browser.authenticate();
    const before = await dump();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pending = browser.get("/accounts");
    await vi.waitFor(() => expect(access.requests).toHaveLength(1), { interval: 1 });
    await vi.advanceTimersByTimeAsync(10_000);
    const response = await pending;
    expect(response.status).toBe(503);
    expect(textOf(await response.text())).toContain(ACCESS_UNAVAILABLE.title);
    expect(access.requests[0]?.signal.aborted).toBe(true);
    expect(await dump()).toEqual(before);
  });

  it("caches keys for warm requests and refreshes once for an unknown key before refusing it", async () => {
    const owner = new Browser();
    await owner.authenticate();
    expect((await owner.get("/accounts")).status).toBe(200);
    expect((await owner.get("/connections")).status).toBe(200);
    expect(access.requests).toHaveLength(1);
    owner.assertion = await signAccessJwt({}, { kid: "unknown", foreign: true });
    const before = await dump();
    expect((await owner.get("/accounts")).status).toBe(403);
    expect(access.requests).toHaveLength(2);
    expect(await dump()).toEqual(before);
  });

  it("refreshes expired keys even when the assertion uses a known key", async () => {
    const now = Date.now();
    vi.useFakeTimers({ toFake: ["Date"], now });
    const owner = new Browser();
    await owner.authenticate();
    expect((await owner.get("/accounts")).status).toBe(200);
    vi.setSystemTime(now + 10 * 60_000);
    expect((await owner.get("/accounts")).status).toBe(200);
    expect(access.requests).toHaveLength(2);
  });

  it("never reuses keys from a different configured issuer", async () => {
    const owner = new Browser();
    await owner.authenticate();
    expect((await owner.get("/accounts")).status).toBe(200);
    const issuer = "https://another-team.cloudflareaccess.com";
    owner.assertion = await signAccessJwt({ iss: issuer });
    access.mode = "fail";
    const response = await owner.get("/accounts", { env: testEnv({ ACCESS_ISSUER: issuer }) });
    expect(response.status).toBe(503);
    expect(access.requests.map((r) => r.url)).toEqual([
      `${testEnv().ACCESS_ISSUER}/cdn-cgi/access/certs`,
      `${issuer}/cdn-cgi/access/certs`,
    ]);
  });

  it("accepts a rotated signing key after refreshing the cached certs", async () => {
    const owner = new Browser();
    await owner.authenticate();
    expect((await owner.get("/accounts")).status).toBe(200);
    access.rotated = true;
    owner.assertion = await signAccessJwt({}, { kid: ROTATED_KEY_ID, foreign: true });
    expect((await owner.get("/connections")).status).toBe(200);
    expect(access.requests).toHaveLength(2);
  });
});

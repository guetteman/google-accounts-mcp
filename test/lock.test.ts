import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { withOwnerGate } from "../src/owner/gate";
import { Browser, clears, setCookies } from "./support/browser";
import { MISMATCH, SETUP_INCOMPLETE, UNAVAILABLE } from "./support/copy";
import { brokenDb, dump, ownerRow, setOwner, watchedDb, writeFailingDb } from "./support/db";
import { google } from "./support/google";
import { callWorker, ORIGIN, OWNER_EMAIL, testEnv, textOf } from "./support/worker";

const NEW_EMAIL = "alex.new@example.com";
const PAGE_PATHS = [
  "/",
  "/accounts",
  "/connections",
  "/signin",
  "/authorize?client_id=x&response_type=code",
];

interface Probe {
  readonly label: string;
  readonly response: Response;
  readonly text: string;
}

/** Every kind of route the gate tells apart, as a browser or an MCP client would call it. */
async function probeEveryRoute(workerEnv: Env, browser = new Browser(() => workerEnv)) {
  const call = async (label: string, request: Request): Promise<Probe> => {
    const response = await callWorker(request, workerEnv);
    return { label, response, text: await response.text() };
  };
  const cookie = browser.cookies.size
    ? [...browser.cookies].map(([n, v]) => `${n}=${v}`).join("; ")
    : "";
  const page = (method: string, path: string) =>
    call(
      `${method} ${path}`,
      new Request(`${ORIGIN}${path}`, {
        method,
        headers: {
          Origin: ORIGIN,
          Cookie: cookie,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: method === "POST" ? "next=%2Faccounts" : undefined,
        redirect: "manual",
      }),
    );
  return {
    pages: [
      ...(await Promise.all(PAGE_PATHS.map((path) => page("GET", path)))),
      await page("GET", "/google/callback?code=c&state=s"),
      await page("POST", "/signin"),
      await page("POST", "/signout"),
      await page("POST", "/signout/all"),
      await page("GET", "/nothing-here"),
    ],
    mcp: [
      await call("GET /mcp", new Request(`${ORIGIN}/mcp`)),
      await call(
        "POST /mcp",
        new Request(`${ORIGIN}/mcp`, {
          method: "POST",
          headers: { Authorization: "Bearer some-token", "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
        }),
      ),
    ],
    token: await call(
      "POST /oauth/token",
      new Request(`${ORIGIN}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "grant_type=authorization_code&code=x",
      }),
    ),
  };
}

function expectTokenEndpointUnavailable(token: Probe) {
  expect(token.response.status).toBe(503);
  expect(JSON.parse(token.text)).toMatchObject({ error: "temporarily_unavailable" });
}

function expectNoSessionSet(probe: Probe) {
  expect(
    setCookies(probe.response).some((c) => c.name === "__Host-session" && !clears(c)),
    probe.label,
  ).toBe(false);
}

describe("missing or invalid configuration", () => {
  it.each([
    ["GOOGLE_CLIENT_SECRET unset", { GOOGLE_CLIENT_SECRET: undefined }, ["GOOGLE_CLIENT_SECRET"]],
    ["GOOGLE_CLIENT_SECRET blank", { GOOGLE_CLIENT_SECRET: "  " }, ["GOOGLE_CLIENT_SECRET"]],
    [
      "OWNER_EMAIL blank and GOOGLE_CLIENT_ID unset",
      { OWNER_EMAIL: "", GOOGLE_CLIENT_ID: undefined },
      ["OWNER_EMAIL", "GOOGLE_CLIENT_ID"],
    ],
    ["OWNER_EMAIL malformed", { OWNER_EMAIL: "not-an-email" }, ["OWNER_EMAIL"]],
  ])(
    "with %s, every route says setup is incomplete and D1 is never read",
    async (_label, overrides, named) => {
      const { db, calls } = watchedDb();
      const workerEnv = testEnv({ ...overrides, DB: db });
      const { pages, mcp, token } = await probeEveryRoute(workerEnv);

      const all = ["OWNER_EMAIL", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"];
      const values = [
        env.OWNER_EMAIL,
        env.GOOGLE_CLIENT_ID,
        env.GOOGLE_CLIENT_SECRET,
        "not-an-email",
      ];
      for (const probe of pages) {
        expect(probe.response.status, probe.label).toBe(503);
        expect(probe.response.headers.get("Location"), probe.label).toBeNull();
        expect(setCookies(probe.response), probe.label).toEqual([]);
        const text = textOf(probe.text);
        expect(text, probe.label).toContain(SETUP_INCOMPLETE.title);
        const positions = named.map((name) => text.indexOf(name));
        expect(
          positions.every((p) => p >= 0),
          probe.label,
        ).toBe(true);
        expect(
          [...positions].sort((a, b) => a - b),
          `${probe.label}: names in order`,
        ).toEqual(positions);
        for (const name of all.filter((n) => !named.includes(n)))
          expect(text, probe.label).not.toContain(name);
        for (const value of values) expect(probe.text, probe.label).not.toContain(value);
      }
      for (const probe of mcp) expect(probe.response.status, probe.label).toBe(503);
      expectTokenEndpointUnavailable(token);
      expect(calls).toEqual([]);
      expect(google.tokenRequests).toHaveLength(0);
    },
  );
});

describe("D1 failures", () => {
  it("answer every route with the database page or 503, and change nothing", async () => {
    const { pages, mcp, token } = await probeEveryRoute(testEnv({ DB: brokenDb() }));

    for (const probe of pages) {
      expect(probe.response.status, probe.label).toBe(503);
      expect(probe.response.headers.get("Location"), probe.label).toBeNull();
      expectNoSessionSet(probe);
      const text = textOf(probe.text);
      expect(text, probe.label).toContain(UNAVAILABLE.title);
      expect(text, probe.label).toContain(UNAVAILABLE.line);
    }
    for (const probe of mcp) expect(probe.response.status, probe.label).toBe(503);
    expectTokenEndpointUnavailable(token);
  });

  it("show the database page with no session when the sign-in's write fails after Google answered", async () => {
    const browser = new Browser();
    const start = await browser.startSignIn();
    const before = await dump();

    const response = await browser.finishSignIn(
      start,
      {},
      { env: testEnv({ DB: writeFailingDb() }) },
    );

    expect(google.tokenRequests).toHaveLength(1);
    expect(response.status).toBe(503);
    expect(textOf(await response.text())).toContain(UNAVAILABLE.title);
    expect(browser.session).toBeUndefined();
    expect(await dump()).toEqual(before);
  });

  it.each([
    ["missing migrations", ["DROP TABLE owner_sessions", "DROP TABLE owner"]],
    ["a deleted owner row", ["DELETE FROM owner"]],
    [
      "an owner row edited by hand",
      [
        "UPDATE owner SET state = 'pinned', email = 'not-an-email', google_sub = 'sub-a' WHERE id = 1",
      ],
    ],
  ])("treat %s as a D1 failure and write nothing", async (_label, statements) => {
    await env.DB.batch(statements.map((sql) => env.DB.prepare(sql)));
    const before = await dump();
    const browser = new Browser();

    for (const response of [
      await browser.get("/accounts"),
      await browser.get("/signin"),
      await browser.post("/signin"),
    ]) {
      expect(response.status).toBe(503);
      expect(textOf(await response.text())).toContain(UNAVAILABLE.title);
    }
    expect(await dump()).toEqual(before);
  });
});

describe("a changed OWNER_EMAIL", () => {
  it("locks every route without showing either address, and changes nothing", async () => {
    const owner = new Browser();
    await owner.signInAsOwner();
    const pendingOwner = new Browser();
    const pendingStart = await pendingOwner.startSignIn();
    const pendingNew = new Browser();
    const pendingNewStart = await pendingNew.startSignIn();
    const before = await dump();
    const locked = testEnv({ OWNER_EMAIL: NEW_EMAIL });

    const { pages, mcp, token } = await probeEveryRoute(locked, owner);
    for (const probe of pages) {
      expect(probe.response.status, probe.label).toBe(503);
      expect(probe.response.headers.get("Location"), probe.label).toBeNull();
      expectNoSessionSet(probe);
      const text = textOf(probe.text);
      expect(text, probe.label).toContain(MISMATCH.title);
      expect(text, probe.label).toContain(MISMATCH.command);
      expect(probe.text, probe.label).not.toContain(OWNER_EMAIL);
      expect(probe.text, probe.label).not.toContain(NEW_EMAIL);
    }
    for (const probe of mcp) expect(probe.response.status, probe.label).toBe(503);
    expectTokenEndpointUnavailable(token);

    // Neither address can sign in, even with a sign-in begun before the change.
    for (const [browser, start, claims] of [
      [pendingOwner, pendingStart, {}],
      [pendingNew, pendingNewStart, { email: NEW_EMAIL, sub: "sub-new" }],
    ] as const) {
      const response = await browser.finishSignIn(start, claims, { env: locked });
      expect(response.status).toBe(503);
      expect(textOf(await response.text())).toContain(MISMATCH.title);
      expect(browser.session).toBeUndefined();
    }
    expect(google.tokenRequests).toHaveLength(0);
    expect(await dump()).toEqual(before);
  });

  it("restores everything, with the same session, once it is set back", async () => {
    const owner = new Browser();
    await owner.signInAsOwner();
    const row = await ownerRow();
    expect(
      (await owner.get("/accounts", { env: testEnv({ OWNER_EMAIL: NEW_EMAIL }) })).status,
    ).toBe(503);

    const response = await owner.get("/accounts", { env: testEnv({ OWNER_EMAIL }) });

    expect(response.status).toBe(200);
    expect(await ownerRow()).toEqual(row);
  });

  it("compares addresses without regard to case or surrounding spaces", async () => {
    const owner = new Browser();
    await owner.signInAsOwner();
    const response = await owner.get("/accounts", {
      env: testEnv({ OWNER_EMAIL: ` ${OWNER_EMAIL.toUpperCase()} ` }),
    });
    expect(response.status).toBe(200);
  });
});

describe("a route behind the gate", () => {
  // A stand-in for a route a later issue adds: it writes to D1 whenever it runs.
  let ran = 0;
  const writer = withOwnerGate(async (_request, workerEnv) => {
    ran++;
    await workerEnv.DB.prepare(
      "INSERT INTO owner_sessions (token_hash, generation, created_at, last_used_at) VALUES (?, 1, 0, 0)",
    )
      .bind(`written-${ran}`)
      .run();
    return new Response("written");
  });
  const callWriter = async (workerEnv: Env) => {
    const ctx = createExecutionContext();
    const response = await writer(
      new Request(`${ORIGIN}/later-route`, { method: "POST" }),
      workerEnv,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    return response;
  };

  it("runs when the deploy is open", async () => {
    ran = 0;
    const response = await callWriter(testEnv());
    expect(await response.text()).toBe("written");
    expect(ran).toBe(1);
  });

  it.each([
    [
      "a mismatch",
      async () => setOwner({ state: "pinned", generation: 1, email: OWNER_EMAIL, google_sub: "a" }),
      testEnv({ OWNER_EMAIL: NEW_EMAIL }),
    ],
    [
      "a reset",
      async () =>
        setOwner({ state: "resetting", generation: 2, email: OWNER_EMAIL, google_sub: "a" }),
      testEnv(),
    ],
    ["missing configuration", async () => {}, testEnv({ GOOGLE_CLIENT_ID: undefined })],
    ["a D1 failure", async () => {}, testEnv({ DB: brokenDb() })],
  ])("never runs during %s", async (_label, arrange, workerEnv) => {
    ran = 0;
    await arrange();
    const before = await dump();

    const response = await callWriter(workerEnv);

    expect(response.status).toBe(503);
    expect(ran).toBe(0);
    expect(await dump()).toEqual(before);
  });
});

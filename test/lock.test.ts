import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { withOwnerGate } from "../src/owner/gate";
import { access, signAccessJwt } from "./support/access";
import { Browser } from "./support/browser";
import { MISMATCH, SETUP_INCOMPLETE, UNAVAILABLE } from "./support/copy";
import {
  brokenDb,
  dump,
  setOwner,
  watchedDb,
  writeFailingDb,
  writeRecordingDb,
} from "./support/db";
import { prepareWrites } from "./support/page-app";
import { callWorker, ORIGIN, OWNER_EMAIL, testEnv, textOf } from "./support/worker";

const NEW_EMAIL = "alex.new@example.com";
const PAGE_PATHS = ["/", "/accounts", "/connections", "/authorize", "/nothing-here"];
async function probeEveryRoute(workerEnv: Env, assertion?: string) {
  const probes = [];
  for (const [method, path] of [
    ...PAGE_PATHS.map((p) => ["GET", p]),
    ["POST", "/accounts"],
    ["POST", "/__test/owner-write"],
    ["GET", "/mcp"],
    ["POST", "/mcp"],
    ["POST", "/oauth/token"],
  ]) {
    const headers = new Headers({ Origin: ORIGIN });
    if (assertion) headers.set("Cf-Access-Jwt-Assertion", assertion);
    const response = await callWorker(
      new Request(`${ORIGIN}${path}`, { method, headers }),
      workerEnv,
    );
    probes.push({ path, response, html: await response.text() });
  }
  return probes;
}

function expectRefusals(probes: Awaited<ReturnType<typeof probeEveryRoute>>, title: string) {
  for (const { path, response, html } of probes) {
    expect(response.status, path).toBe(503);
    expect(response.headers.get("Location"), path).toBeNull();
    expect(response.headers.getSetCookie(), path).toEqual([]);
    if (path === "/oauth/token")
      expect(JSON.parse(html)).toEqual({ error: "temporarily_unavailable" });
    else if (path !== "/mcp") expect(textOf(html), path).toContain(title);
    expect(html, path).not.toContain(OWNER_EMAIL);
    expect(html, path).not.toContain(NEW_EMAIL);
  }
}

describe("missing or invalid configuration", () => {
  it.each([
    ["ACCESS_AUDIENCE unset", { ACCESS_AUDIENCE: undefined }, ["ACCESS_AUDIENCE"]],
    ["ACCESS_AUDIENCE blank", { ACCESS_AUDIENCE: " " }, ["ACCESS_AUDIENCE"]],
    [
      "OWNER_EMAIL blank and ACCESS_ISSUER unset",
      { OWNER_EMAIL: " ", ACCESS_ISSUER: undefined },
      ["OWNER_EMAIL", "ACCESS_ISSUER"],
    ],
    ["OWNER_EMAIL malformed", { OWNER_EMAIL: "not-an-email" }, ["OWNER_EMAIL"]],
    [
      "ACCESS_ISSUER on another domain",
      { ACCESS_ISSUER: "https://evil.example" },
      ["ACCESS_ISSUER"],
    ],
    [
      "ACCESS_ISSUER with a trailing slash",
      { ACCESS_ISSUER: "https://example-team.cloudflareaccess.com/" },
      ["ACCESS_ISSUER"],
    ],
    [
      "ACCESS_ISSUER with a path",
      { ACCESS_ISSUER: "https://example-team.cloudflareaccess.com/path" },
      ["ACCESS_ISSUER"],
    ],
    [
      "ACCESS_ISSUER over HTTP",
      { ACCESS_ISSUER: "http://example-team.cloudflareaccess.com" },
      ["ACCESS_ISSUER"],
    ],
    ["ACCESS_AUDIENCE too short", { ACCESS_AUDIENCE: "a".repeat(63) }, ["ACCESS_AUDIENCE"]],
    ["ACCESS_AUDIENCE not hex", { ACCESS_AUDIENCE: "z".repeat(64) }, ["ACCESS_AUDIENCE"]],
  ])(
    "with %s every route names only the invalid settings before reading D1 or fetching certs",
    async (_label, overrides, names) => {
      const { db, calls } = watchedDb();
      const workerEnv = testEnv({ ...overrides, DB: db });
      const probes = await probeEveryRoute(workerEnv);
      expectRefusals(probes, SETUP_INCOMPLETE.title);
      for (const { path, html } of probes.filter(
        (p) => p.path !== "/mcp" && p.path !== "/oauth/token",
      )) {
        const text = textOf(html);
        const positions = names.map((name) => text.indexOf(name));
        expect(
          positions.every((p) => p >= 0),
          path,
        ).toBe(true);
        expect(
          [...positions].sort((a, b) => a - b),
          path,
        ).toEqual(positions);
        for (const name of ["OWNER_EMAIL", "ACCESS_ISSUER", "ACCESS_AUDIENCE"].filter(
          (n) => !names.includes(n),
        ))
          expect(text, path).not.toContain(name);
        for (const value of Object.values(workerEnv).filter(
          (v) => typeof v === "string" && v.trim(),
        ))
          expect(html, path).not.toContain(value);
      }
      expect(calls).toEqual([]);
      expect(access.requests).toEqual([]);
    },
  );
});

describe("D1 failures", () => {
  it("refuses every route with the database page or protocol error before fetching certs", async () => {
    const before = await dump();
    const probes = await probeEveryRoute(testEnv({ DB: brokenDb() }), await signAccessJwt());
    expectRefusals(probes, UNAVAILABLE.title);
    for (const { path, html } of probes.filter(
      (p) => p.path !== "/mcp" && p.path !== "/oauth/token",
    ))
      expect(textOf(html), path).toContain(UNAVAILABLE.line);
    expect(access.requests).toEqual([]);
    expect(await dump()).toEqual(before);
  });

  it("shows the database failure page when a verified owner's pin cannot be written", async () => {
    const owner = new Browser();
    await owner.authenticate();
    const before = await dump();
    const response = await owner.get("/accounts", { env: testEnv({ DB: writeFailingDb() }) });
    expect(access.requests).toHaveLength(1);
    expect(response.status).toBe(503);
    expect(textOf(await response.text())).toContain(UNAVAILABLE.title);
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(await dump()).toEqual(before);
  });

  it.each([
    "missing migrations",
    "a deleted row",
    "an invalid email",
    "an invalid generation",
    "an invalid instance",
  ])("treats %s as a database failure without writing", async (kind) => {
    if (kind.startsWith("an invalid")) {
      await setOwner({ state: "pinned", generation: 1, email: OWNER_EMAIL });
      await env.DB.exec("PRAGMA ignore_check_constraints = ON");
      const sql =
        kind === "an invalid email"
          ? "email = 'not-an-email'"
          : kind === "an invalid generation"
            ? "generation = 0"
            : "instance = 0";
      await env.DB.prepare(`UPDATE owner SET ${sql} WHERE id = 1`).run();
      await env.DB.exec("PRAGMA ignore_check_constraints = OFF");
    } else
      await env.DB.prepare(
        kind === "missing migrations" ? "DROP TABLE owner" : "DELETE FROM owner",
      ).run();
    const watched = writeRecordingDb();
    const before = await dump();
    expectRefusals(await probeEveryRoute(testEnv({ DB: watched.db })), UNAVAILABLE.title);
    expect(watched.writes).toEqual([]);
    expect(await dump()).toEqual(before);
  });
});

describe("owner lock", () => {
  it.each(["missing", "invalid", "previous owner", "new address"])(
    "locks every route with %s assertion before fetching keys or changing data",
    async (kind) => {
      await setOwner({ state: "pinned", generation: 1, email: OWNER_EMAIL });
      const before = await dump();
      const assertion =
        kind === "missing"
          ? undefined
          : kind === "invalid"
            ? "bad"
            : await signAccessJwt({ email: kind === "previous owner" ? OWNER_EMAIL : NEW_EMAIL });
      const probes = await probeEveryRoute(testEnv({ OWNER_EMAIL: NEW_EMAIL }), assertion);
      expectRefusals(probes, MISMATCH.title);
      for (const { path, html } of probes.filter(
        (p) => p.path !== "/mcp" && p.path !== "/oauth/token",
      ))
        expect(textOf(html), path).toContain(MISMATCH.command);
      expect(access.requests).toEqual([]);
      expect(await dump()).toEqual(before);
    },
  );

  it("restores access without changing the owner row when OWNER_EMAIL is set back", async () => {
    await setOwner({ state: "pinned", generation: 4, email: OWNER_EMAIL });
    const owner = new Browser();
    await owner.authenticate();
    const before = await dump();
    expect(
      (await owner.get("/accounts", { env: testEnv({ OWNER_EMAIL: NEW_EMAIL }) })).status,
    ).toBe(503);
    expect((await owner.get("/accounts", { env: testEnv({ OWNER_EMAIL }) })).status).toBe(200);
    expect(await dump()).toEqual(before);
  });

  it.each([OWNER_EMAIL, NEW_EMAIL])(
    "locks every route during a reset even when OWNER_EMAIL is %s",
    async (email) => {
      await setOwner({ state: "resetting", generation: 2, email: OWNER_EMAIL });
      const before = await dump();
      expectRefusals(
        await probeEveryRoute(testEnv({ OWNER_EMAIL: email }), await signAccessJwt({ email })),
        MISMATCH.title,
      );
      expect(access.requests).toEqual([]);
      expect(await dump()).toEqual(before);
    },
  );
});

describe("a future route behind the gate", () => {
  let ran = 0;
  const writer = withOwnerGate(async (_request, workerEnv) => {
    ran++;
    await workerEnv.DB.prepare("INSERT INTO test_writes VALUES (1, 'future-route')").run();
    return new Response("written");
  });
  async function callWriter(workerEnv: Env) {
    const ctx = createExecutionContext();
    const response = await writer(
      new Request(`${ORIGIN}/later-route`, { method: "POST" }),
      workerEnv,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    return response;
  }
  it("runs when the gate is open", async () => {
    await prepareWrites();
    ran = 0;
    expect(await (await callWriter(testEnv())).text()).toBe("written");
    expect(ran).toBe(1);
  });
  it.each(["a mismatch", "a reset", "missing configuration", "D1 down"])(
    "never runs during %s",
    async (kind) => {
      await prepareWrites();
      ran = 0;
      if (kind === "a mismatch" || kind === "a reset")
        await setOwner({
          state: kind === "a reset" ? "resetting" : "pinned",
          generation: 2,
          email: OWNER_EMAIL,
        });
      const workerEnv = testEnv({
        ...(kind === "a mismatch" ? { OWNER_EMAIL: NEW_EMAIL } : {}),
        ...(kind === "missing configuration" ? { ACCESS_AUDIENCE: undefined } : {}),
        ...(kind === "D1 down" ? { DB: brokenDb() } : {}),
      });
      const before = await dump();
      expect((await callWriter(workerEnv)).status).toBe(503);
      expect(ran).toBe(0);
      expect(await dump()).toEqual(before);
    },
  );
});

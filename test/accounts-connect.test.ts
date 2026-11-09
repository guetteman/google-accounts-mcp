import { env } from "cloudflare:workers";
import { expect, it, vi } from "vite-plus/test";
import "./support/account-checks";
import { Browser } from "./support/browser";
import {
  accounts,
  finish,
  fixtureOpen,
  NOW,
  ownerBrowser,
  seedAccount,
  start,
} from "./support/accounts";
import { google, SCOPES } from "./support/google";
import { dump, observeStatements, statementFailingDb } from "./support/db";
import { ORIGIN, OWNER_EMAIL, testEnv, textOf } from "./support/worker";
import { resetOwner } from "./support/connections";
const DIDNT =
  "Didn't finish. It expired, was cancelled, or started in another browser. Nothing changed. Try again.";

it("connects with offline consent and PKCE, seals both tokens, and consumes the result alert once", async () => {
  const browser = await ownerBrowser();
  expect(textOf(await (await browser.get("/accounts")).text())).toContain("No Google accounts yet");
  const { url, response } = await start(browser);
  const p = url.searchParams;
  expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
  for (const [key, value] of Object.entries({
    client_id: testEnv().GOOGLE_CLIENT_ID,
    redirect_uri: `${ORIGIN}/google/callback`,
    response_type: "code",
    access_type: "offline",
    prompt: "consent select_account",
    code_challenge_method: "S256",
  }))
    expect(p.get(key)).toBe(value);
  expect(p.get("scope")!.split(" ").sort()).toEqual(["openid", "email", ...SCOPES].sort());
  expect(p.get("code_challenge")).toMatch(/^[\w-]{43}$/);
  const cookie = response.headers
    .getSetCookie()
    .find((c) => c.startsWith(`__Host-g-${p.get("state")}=`))!;
  for (const attr of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/", "Max-Age=600"])
    expect(cookie).toContain(attr);
  expect(cookie).not.toContain("Domain=");
  const result = await finish(browser, url);
  expect(result.text).toContain(`Connected ${OWNER_EMAIL}.`);
  expect(result.text).toContain("Ready");
  const [row] = await accounts();
  expect(row).toMatchObject({ email: OWNER_EMAIL, name: OWNER_EMAIL, health: "ready" });
  expect(row!.refresh_token).toMatch(/^v1\./);
  expect(row!.access_token).toMatch(/^v1\./);
  expect(await fixtureOpen(`${row!.id}:access`, row!.access_token!)).toBe(google.issuedAccess[0]);
  expect(textOf(await (await browser.get("/accounts")).text())).not.toContain(
    `Connected ${OWNER_EMAIL}.`,
  );
});
it("labels Workspace from the hosted-domain claim and leaves personal accounts unlabelled", async () => {
  const b = await ownerBrowser();
  await finish(b, (await start(b)).url);
  expect(textOf(await (await b.get("/accounts")).text())).not.toContain("Workspace");
  const result = await finish(b, (await start(b)).url, {
    claims: { sub: "work", email: "alex@harbor.example", hd: "harbor.example" },
  });
  expect(result.text).toContain("alex@harbor.example · Workspace");
});
it.each([0, 2])("counts only the %s granted Gmail permissions", async (count) => {
  const b = await ownerBrowser();
  const result = await finish(b, (await start(b)).url, {
    scope: [
      "openid",
      "email",
      "https://www.googleapis.com/auth/userinfo.email",
      ...SCOPES.slice(0, count),
    ].join(" "),
  });
  expect(result.text).toContain(
    `Missing access. Google granted ${count} of the 5 permissions Gmail needs. Reconnect and check every box.`,
  );
  expect(await accounts()).toHaveLength(1);
});
it.each([
  { GOOGLE_CLIENT_ID: undefined },
  { GOOGLE_CLIENT_ID: "bad-client" },
  { GOOGLE_CLIENT_SECRET: undefined },
  { GOOGLE_CLIENT_SECRET: "" },
  { TOKEN_KEY: undefined },
  { TOKEN_KEY: "not-a-64-hex-key" },
])("refuses every route when Google configuration is invalid: %j", async (overrides) => {
  const b = await ownerBrowser();
  const before = await dump();
  for (const path of ["/accounts", "/google/callback", "/mcp", "/oauth/token", "/nothing-here"]) {
    const response = await b.get(path, { env: testEnv(overrides) });
    expect(response.status).toBe(503);
    const body = await response.text();
    if (path.startsWith("/oauth/"))
      expect(JSON.parse(body)).toEqual({ error: "temporarily_unavailable" });
    else if (path !== "/mcp") {
      expect(textOf(body)).toContain("This server isn't set up yet");
      expect(body).toContain(Object.keys(overrides)[0]);
      for (const v of Object.values(overrides)) if (v) expect(body).not.toContain(v);
    }
  }
  expect(await dump()).toEqual(before);
});
it.each(["anonymous", "other owner", "cross-site"])(
  "protects every account action from %s requests",
  async (kind) => {
    const row = await seedAccount();
    const b = new Browser();
    if (kind !== "anonymous")
      await b.authenticate(kind === "other owner" ? { email: "other@example.com" } : {});
    const before = await dump();
    for (const path of [
      "/accounts/connect",
      ...["reconnect", "name", "remove"].map((a) => `/accounts/${row.id}/${a}`),
      ...(kind === "cross-site" ? [] : ["/google/callback?code=forged&state=forged"]),
    ]) {
      const options = kind === "cross-site" ? { origin: "https://another.example" } : {};
      const r = path.startsWith("/google")
        ? await b.get(path)
        : await b.post(path, { name: "Work", disconnect: "1" }, options);
      expect(r.status).toBe(403);
      expect(r.headers.getSetCookie()).toEqual([]);
      expect(await dump()).toEqual(before);
    }
    expect(google.events).toEqual([]);
  },
);
it.each(["missing", "other state", "expired", "replayed", "cancelled", "refused code"])(
  "rejects a %s callback and clears its own flow cookie",
  async (kind) => {
    const b = await ownerBrowser();
    const { url } = await start(b);
    const state = url.searchParams.get("state")!;
    let callback = google.issueCode(url);
    const cookie = [...b.cookies.get(ORIGIN)!].map(([k, v]) => `${k}=${v}`).join("; ");
    if (kind === "replayed") await b.get(callback);
    if (kind === "missing") b.cookies.clear();
    if (kind === "other state") callback = callback.replace(state, crypto.randomUUID());
    if (kind === "expired") vi.spyOn(Date, "now").mockReturnValue(NOW + 601000);
    if (kind === "cancelled") callback = `/google/callback?state=${state}&error=access_denied`;
    if (kind === "refused code") google.codes.clear();
    const before = await dump();
    const response = await b.get(
      callback,
      kind === "expired" ? { headers: { Cookie: cookie } } : {},
    );
    expect(response.status).toBe(303);
    expect(
      response.headers
        .getSetCookie()
        .some(
          (c) =>
            c.startsWith(`__Host-g-${new URL(callback, ORIGIN).searchParams.get("state")}=`) &&
            c.includes("Max-Age=0"),
        ),
    ).toBe(true);
    expect(textOf(await (await b.get("/accounts")).text())).toContain(DIDNT);
    expect(await dump()).toEqual(before);
  },
);
it("refuses a Google flow started before the owner reset", async () => {
  const b = await ownerBrowser();
  const { url } = await start(b);
  await resetOwner();
  await b.get("/accounts");
  const before = await dump();
  expect((await finish(b, url)).text).toContain(DIDNT);
  expect(await dump()).toEqual(before);
  expect(google.events).toEqual([]);
});
it.each([503, 429, "slow"] as const)(
  "leaves the database unchanged when the code exchange answers %s",
  async (answer) => {
    const b = await ownerBrowser();
    const { url } = await start(b);
    const before = await dump();
    google.exchangeAnswer = answer;
    if (answer === "slow") vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pending = finish(b, url);
    if (answer === "slow") {
      await vi.waitFor(() => expect(google.pending).toHaveLength(1));
      await vi.advanceTimersByTimeAsync(10001);
    }
    expect((await pending).text).toContain(
      "Google didn't answer. Nothing changed. Try again in a minute.",
    );
    expect(await dump()).toEqual(before);
  },
);
it("refuses a grant without lasting refresh access", async () => {
  const b = await ownerBrowser();
  const before = await dump();
  expect((await finish(b, (await start(b)).url, { noRefresh: true })).text).toContain(
    "Google didn't return lasting access. Nothing changed. Try again.",
  );
  expect(await dump()).toEqual(before);
});
it.each([
  { sub: undefined },
  { email: undefined },
  { email_verified: false },
  { email_verified: "true" },
  { iss: "https://other.example" },
  { aud: "other-client" },
  { exp: Math.floor(NOW / 1000) - 1 },
])("refuses invalid identity claims %j", async (claims) => {
  const b = await ownerBrowser();
  const before = await dump();
  expect((await finish(b, (await start(b)).url, { claims })).text).toContain(DIDNT);
  expect(await dump()).toEqual(before);
});
it.each([false, true])(
  "reports an uncertain account insert when its response is lost after commit: %s",
  async (committed) => {
    const b = await ownerBrowser();
    const { url } = await start(b);
    const db = committed
      ? observeStatements(
          env.DB,
          () => {},
          (sql) => {
            if (/INSERT INTO accounts/i.test(sql)) throw new Error("lost response");
          },
        )
      : statementFailingDb(/accounts/);
    const result = await finish(b, url, {}, testEnv({ DB: db }));
    expect(result.text).toContain(
      "Couldn't confirm the change. Reload the page to see whether it happened.",
    );
    expect(await accounts()).toHaveLength(committed ? 1 : 0);
    const retry = await finish(b, (await start(b)).url);
    expect(retry.text).toContain(
      committed
        ? `${OWNER_EMAIL} is already connected. Reconnect it from its row.`
        : `Connected ${OWNER_EMAIL}.`,
    );
  },
);
it("refuses an add of an existing subject even when Google returns a different address", async () => {
  await seedAccount({ sub: "personal" });
  const b = await ownerBrowser();
  const before = await dump();
  expect(
    (await finish(b, (await start(b)).url, { claims: { email: "changed@example.com" } })).text,
  ).toContain(`${OWNER_EMAIL} is already connected. Reconnect it from its row.`);
  expect(await dump()).toEqual(before);
});
it("keeps exactly one account when two add flows return the same Google subject", async () => {
  const b = await ownerBrowser();
  const one = await start(b);
  const otherBrowser = await ownerBrowser();
  const two = await start(otherBrowser);
  const results = await Promise.all([finish(b, one.url), finish(otherBrowser, two.url)]);
  expect(await accounts()).toHaveLength(1);
  expect(results.map((r) => r.text).join(" ")).toContain(
    "is already connected. Reconnect it from its row.",
  );
});
it.each(["add", "reconnect"])(
  "refuses a different subject taking another account's address on %s",
  async (kind) => {
    await seedAccount({ email: "alex@harbor.example", sub: "C", name: "Work" });
    const other = await seedAccount({
      email: "alex.projects@example.com",
      sub: kind === "add" ? "other" : "D",
    });
    const b = await ownerBrowser();
    const before = await dump();
    const result = await finish(
      b,
      (await start(b, kind === "reconnect" ? other.id : undefined)).url,
      { claims: { sub: "D", email: "alex@harbor.example" } },
    );
    expect(result.text).toContain(
      "Nothing changed. Another Google account already uses alex@harbor.example here. Reconnect or remove Work first.",
    );
    expect(await dump()).toEqual(before);
  },
);
it("binds reconnect to its original subject and supplies its login hint", async () => {
  const row = await seedAccount({ email: "alex.projects@example.com", sub: "projects" });
  await seedAccount();
  const b = await ownerBrowser();
  const before = await dump();
  const { url } = await start(b, row.id);
  expect(url.searchParams.get("login_hint")).toBe(row.email);
  expect(url.searchParams.get("prompt")).toBe("consent");
  expect((await finish(b, url)).text).toContain(
    `Nothing changed. You signed in to Google as ${OWNER_EMAIL}, but this reconnect is for ${row.email}.`,
  );
  expect(await dump()).toEqual(before);
});
it.each(["removed", "reconnected"])(
  "rejects a reconnect callback after the account was %s",
  async (change) => {
    const row = await seedAccount({ sub: "personal" });
    const b = await ownerBrowser();
    const { url } = await start(b, row.id);
    if (change === "removed") await b.post(`/accounts/${row.id}/remove`);
    else await finish(b, (await start(b, row.id)).url);
    const before = await dump();
    expect((await finish(b, url)).text).toContain(
      `Nothing changed. ${row.email} changed while you were at Google. Try again.`,
    );
    expect(await dump()).toEqual(before);
  },
);
it.each(["needs_reconnect", "blocked_by_admin"] as const)(
  "reconnects a %s account with its ID and name intact and never revokes",
  async (health) => {
    const row = await seedAccount({
      sub: "personal",
      name: "Work",
      health,
      ...(health === "needs_reconnect"
        ? { refresh_token: null, access_token: null }
        : { blocked_until: NOW + 600000 }),
    });
    const b = await ownerBrowser();
    expect(
      (
        await finish(b, (await start(b, row.id)).url, {
          claims: { email: "new.address@example.com" },
        })
      ).text,
    ).toContain(
      "Reconnected new.address@example.com. Every connection keeps the permissions it had for this account.",
    );
    expect((await accounts())[0]).toMatchObject({
      id: row.id,
      name: "Work",
      email: "new.address@example.com",
      health: "ready",
      version: row.version + 1,
      scopes: JSON.stringify(SCOPES),
    });
    expect(google.events).not.toContain("revoke");
  },
);

it("guards a reconnect write when removal lands after the callback read its cookie", async () => {
  const row = await seedAccount({ sub: "personal" });
  const b = await ownerBrowser();
  const { url } = await start(b, row.id);
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((r) => {
    enter = r;
  });
  const blocked = new Promise<void>((r) => {
    release = r;
  });
  const db = observeStatements(env.DB, async (sql) => {
    if (/UPDATE accounts/i.test(sql)) {
      enter();
      await blocked;
    }
  });
  const callback = b.get(google.issueCode(url), { env: testEnv({ DB: db }) });
  try {
    expect(
      await Promise.race([entered.then(() => "paused"), callback.then(() => "finished")]),
    ).toBe("paused");
    expect(await (await b.post(`/accounts/${row.id}/remove`)).json()).toEqual({ outcome: "ok" });
    const before = await accounts();
    release();
    await callback;
    expect(await accounts()).toEqual(before);
    expect(textOf(await (await b.get("/accounts")).text())).toContain(
      `Nothing changed. ${row.email} changed while you were at Google. Try again.`,
    );
  } finally {
    release();
    await callback;
  }
});

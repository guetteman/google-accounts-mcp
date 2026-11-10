import { Effect, Result } from "effect";
import { http, HttpResponse } from "msw";
import { withGoogle } from "../src/accounts/tokens";
import { readConfig } from "../src/config";
import { readOwner } from "../src/owner/owner";
import { network } from "./support/network";
import { env } from "cloudflare:workers";
import { expect, it, vi } from "vite-plus/test";
import { recordedConsole } from "./support/account-checks";
import {
  accounts,
  call,
  credential,
  finish,
  fixtureOpen,
  NOW,
  ownerBrowser,
  seedAccount,
  start,
} from "./support/accounts";
import { dump, observeStatements } from "./support/db";
import { deferred, google, GMAIL } from "./support/google";
import { ORIGIN, testEnv, textOf, observedBodies } from "./support/worker";

const CLIENT =
  "Google refused this server's OAuth client. Check GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET. Nothing changed.";

it("ends reconnect with an alert when an earlier owner's account holds the returned address", async () => {
  const target = await seedAccount({ sub: "personal" });
  await seedAccount({ generation: 0, sub: "earlier", email: "earlier@example.com" });
  const b = await ownerBrowser();
  const { url } = await start(b, target.id);
  const before = await dump();
  const response = await b.get(
    google.issueCode(url, {
      claims: { sub: target.sub, email: "earlier@example.com" },
    }),
  );
  expect(response.status).toBe(303);
  expect(response.headers.get("Location")).toBe("/accounts");
  const flowCookie = `__Host-g-${url.searchParams.get("state")}`;
  expect(
    response.headers.getSetCookie().find((value) => value.startsWith(`${flowCookie}=`)),
  ).toContain("Max-Age=0");
  expect(b.cookies.get(ORIGIN)!.has(flowCookie)).toBe(false);
  expect(textOf(await (await b.get("/accounts")).text())).toContain(
    `Nothing changed. ${target.email} changed while you were at Google. Try again.`,
  );
  expect(await dump()).toEqual(before);
});

it.each(["Ready", "an expired block"])(
  "keeps a saved admin block when an earlier accepted refresh from %s arrives late",
  async (initial) => {
    const row = await seedAccount({
      access_expires_at: NOW,
      ...(initial === "Ready"
        ? {}
        : ({ health: "blocked_by_admin", blocked_until: NOW - 1 } as const)),
    });
    const snapshot = await credential(row.id);
    const entered = deferred(),
      release = deferred();
    const db = observeStatements(env.DB, async (sql) => {
      if (sql.includes("SET access_token =")) {
        entered.resolve();
        await release.promise;
      }
    });
    const pending = call(row.id, db, snapshot);
    try {
      await entered.promise;
      if (initial !== "Ready") vi.spyOn(Date, "now").mockReturnValue(NOW + 600000);
      google.refreshAnswers = ["admin_policy_enforced"];
      expect(await call(row.id, env.DB, snapshot)).toMatchObject({ error: "BlockedByAdmin" });
      const before = await accounts();
      release.resolve();
      expect(await pending).toMatchObject({ error: "BlockedByAdmin" });
      expect(await accounts()).toEqual(before);
      vi.spyOn(Date, "now").mockReturnValue(NOW + (initial === "Ready" ? 60000 : 660000));
      expect(await call(row.id)).toMatchObject({ error: "BlockedByAdmin" });
      expect(google.events).toEqual(["refresh", "refresh"]);
    } finally {
      release.resolve();
      await pending;
    }
  },
);

it.each(["unknown version", "decrypt unavailable"])(
  "preserves stored access after %s and works after recovery",
  async (kind) => {
    const row = await seedAccount({ access_expires_at: NOW });
    if (kind === "unknown version")
      await env.DB.prepare("UPDATE accounts SET refresh_token = ? WHERE id = ?")
        .bind(row.refresh_token!.replace(/^v1\./, "v2."), row.id)
        .run();
    const before = await accounts();
    const failure =
      kind === "decrypt unavailable"
        ? vi
            .spyOn(crypto.subtle, "decrypt")
            .mockRejectedValue(new DOMException("local cryptography failed", "InvalidAccessError"))
        : null;
    expect(await call(row.id)).toMatchObject({ error: "Unavailable" });
    expect(await accounts()).toEqual(before);
    expect(google.events).toEqual([]);
    expect(recordedConsole()).toHaveLength(1);
    failure?.mockRestore();
    await env.DB.prepare("UPDATE accounts SET refresh_token = ? WHERE id = ?")
      .bind(row.refresh_token, row.id)
      .run();
    expect(await call(row.id)).toMatchObject({ status: 200 });
  },
);

it.each([
  "deleted_client",
  "disabled_client",
  "unauthorized_client",
  "redirect_uri_mismatch",
  "invalid_request",
  "invalid_client",
])("names a permanent OAuth client error %s regardless of HTTP status", async (error) => {
  const b = await ownerBrowser();
  for (const status of [400, 401, 200]) {
    google.exchangeAnswer = { status, body: JSON.stringify({ error }) };
    expect((await finish(b, (await start(b)).url)).text).toContain(CLIENT);
    expect(await accounts()).toEqual([]);
  }
  expect(recordedConsole()).toHaveLength(3);
});

it("identifies a rejected Google identity as a client failure, not an expired flow", async () => {
  const b = await ownerBrowser();
  expect(
    (await finish(b, (await start(b)).url, { claims: { aud: "another-client" } })).text,
  ).toContain(CLIENT);
  expect(recordedConsole()).toHaveLength(1);
  expect(await accounts()).toEqual([]);
});

it.each(["other key", "unknown version"])(
  "shows unreadable access instead of Ready for %s without exposing token prefixes",
  async (kind) => {
    const row = await seedAccount();
    const b = await ownerBrowser();
    if (kind === "unknown version")
      await env.DB.prepare("UPDATE accounts SET refresh_token = ? WHERE id = ?")
        .bind(row.refresh_token!.replace(/^v1\./, "v2."), row.id)
        .run();
    const before = await dump();
    const response = await b.get("/accounts", {
      env: testEnv(kind === "other key" ? { TOKEN_KEY: "c".repeat(64) } : {}),
    });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(textOf(html)).toContain("Can't read its stored access. Check TOKEN_KEY.");
    expect(textOf(html)).not.toContain("Ready");
    expect(html).not.toContain(row.refresh_token!.slice(0, 20));
    expect(await dump()).toEqual(before);
    expect(google.events).toEqual([]);
  },
);

it.each(["z".repeat(64), "a".repeat(65), "b".repeat(66)])(
  "rejects TOKEN_KEY outside exactly 64 hexadecimal characters: %s",
  async (TOKEN_KEY) => {
    const b = await ownerBrowser();
    const response = await b.get("/accounts", { env: testEnv({ TOKEN_KEY }) });
    expect(response.status).toBe(503);
    expect(textOf(await response.text())).toContain("TOKEN_KEY");
  },
);

it.each(["ok", "invalid_grant"] as const)(
  "reports the exact disconnect outcome when Google answers %s",
  async (answer) => {
    const first = await seedAccount({ email: "first@example.com", sub: "first" });
    const chosen = await seedAccount({
      email: "chosen@example.com",
      sub: "chosen",
      created_at: NOW + 1,
    });
    const b = await ownerBrowser();
    google.revokeAnswer = answer;
    expect(
      await (await b.post(`/accounts/${chosen.id}/remove`, { disconnect: "1" })).json(),
    ).toEqual({ outcome: "ok" });
    const html = await (await b.get("/accounts")).text();
    const props = JSON.parse(/id="page-props"[^>]*>([\s\S]*?)<\/script>/.exec(html)![1]!);
    expect(props.alert).toEqual({
      kind: answer === "ok" ? "removed" : "removed_unconfirmed",
      address: chosen.email,
    });
    const status = /role="status"[^>]*>([\s\S]*?)<\/div>/.exec(html)![1]!;
    expect(textOf(status)).toBe(
      answer === "ok"
        ? `Removed ${chosen.email}.`
        : `Removed ${chosen.email}. Google didn't confirm the disconnect.`,
    );
    expect(google.revokedTokens).toEqual([
      await fixtureOpen(`${chosen.id}:refresh`, chosen.refresh_token!),
    ]);
    expect((await accounts())[0]).toEqual(first);
  },
);

it("normalizes a Google address and updates its Workspace domain on reconnect", async () => {
  const b = await ownerBrowser();
  await finish(b, (await start(b)).url, {
    claims: { email: "Alex.Personal@Example.COM", hd: "old.example" },
  });
  const row = (await accounts())[0]!;
  expect(row.email).toBe("alex.personal@example.com");
  await finish(b, (await start(b, row.id)).url, {
    claims: { email: "Alex.Personal@Example.COM", hd: "new.example" },
  });
  expect((await accounts())[0]).toMatchObject({
    email: "alex.personal@example.com",
    hd: "new.example",
  });
});

it("consumes the successful flow cookie and protects the short-lived alert cookie", async () => {
  const b = await ownerBrowser();
  const { url } = await start(b);
  const response = await b.get(google.issueCode(url));
  const cookies = response.headers.getSetCookie();
  expect(cookies.find((c) => c.startsWith(`__Host-g-${url.searchParams.get("state")}=`))).toContain(
    "Max-Age=0",
  );
  expect(b.cookies.get(ORIGIN)!.has(`__Host-g-${url.searchParams.get("state")}`)).toBe(false);
  const alert = cookies.find((c) => c.startsWith("__Host-accounts-outcome="))!;
  expect(alert.split(";").map((attribute) => attribute.trim())).toContain("HttpOnly");
  expect(alert.split(";").map((attribute) => attribute.trim())).toContain("Max-Age=60");
});

it.each(["connect", "reconnect"])("refuses a missing form before starting %s", async (action) => {
  const row = await seedAccount();
  const b = await ownerBrowser();
  const before = await dump();
  const response = await b.request(
    action === "connect" ? "/accounts/connect" : `/accounts/${row.id}/reconnect`,
    { method: "POST" },
  );
  expect(response.status).toBe(400);
  expect(response.headers.getSetCookie()).toEqual([]);
  expect(await dump()).toEqual(before);
});

it.each([200, 401])(
  "builds a fresh service request and body for the one retry, returning the final %s",
  async (status) => {
    const row = await seedAccount();
    const config = readConfig(testEnv());
    if (Result.isFailure(config)) throw new Error("Invalid test config");
    const owner = await Effect.runPromise(readOwner(env.DB));
    const bodies: string[] = [];
    network.use(
      http.post(GMAIL, async ({ request }) => {
        bodies.push(new TextDecoder().decode(await request.arrayBuffer()));
        return HttpResponse.json(
          { received: true },
          { status: bodies.length === 1 ? 401 : status },
        );
      }),
    );
    const built: Request[] = [];
    const controller = new AbortController();
    const response = await Effect.runPromise(
      withGoogle(
        {
          db: env.DB,
          config: config.success,
          owner: { generation: owner.generation, email: owner.email! },
          now: Date.now,
        },
        await credential(row.id),
        (token) => {
          const request = new Request(GMAIL, {
            method: "POST",
            headers: { Authorization: `Bearer ${token}` },
            body: new URLSearchParams({ query: "example" }),
            signal: controller.signal,
          });
          built.push(request);
          return request;
        },
      ),
    );
    observedBodies.push({
      body: await response.text(),
      headers: [...response.headers],
      cookies: response.headers.getSetCookie(),
    });
    expect(response.status).toBe(status);
    expect(built).toHaveLength(2);
    expect(built[0]).not.toBe(built[1]);
    expect(bodies).toEqual(["query=example", "query=example"]);
    expect(google.refreshTokens).toHaveLength(1);
  },
);

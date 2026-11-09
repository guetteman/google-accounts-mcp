import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { access, signAccessJwt } from "./support/access";
import { Browser } from "./support/browser";
import { ACCESS_REFUSED, ACCESS_UNAVAILABLE, NOT_OWNER, UNAVAILABLE } from "./support/copy";
import {
  committedConnectionFailureDb,
  dump,
  kvDump,
  restoreKv,
  statementFailingDb,
} from "./support/db";
import { NOW, onlyConnection, pinOwner, resetOwner, rows } from "./support/connections";
import { clients, codeClient, expectOAuthError, McpClient, oauth } from "./support/oauth";
import { HOST, OWNER_EMAIL, testEnv, textOf } from "./support/worker";

async function expired(response: Response) {
  expect(response.status).toBe(400);
  expect(response.headers.get("Location")).toBeNull();
  const text = textOf(await response.text());
  expect(text).toContain("This connection request expired");
  expect(text).toContain(
    "It was already used, took longer than 10 minutes, or started in another browser. Nothing was connected. Start again from the app.",
  );
}

describe("owner consent", () => {
  for (const method of ["GET", "POST"]) {
    it.each(["missing", "invalid", "another email", "keys unavailable"])(
      `requires the owner at ${method} consent with %s identity`,
      async (kind) => {
        await pinOwner();
        const mcp = new McpClient();
        const browser = new Browser();
        if (kind === "invalid") browser.assertion = "invalid";
        if (kind === "another email")
          await browser.authenticate({ email: "someone.else@example.com" });
        if (kind === "keys unavailable") {
          await browser.authenticate();
          access.mode = "fail";
        }
        const before = await dump();
        const path = await mcp.authorizePath();
        const response =
          method === "GET"
            ? await browser.get(path)
            : await browser.post(path, {
                handle: "not-a-handle",
                generation: "1",
                name: "Work laptop",
                decision: "approve",
              });
        expect(response.status).toBe(kind === "keys unavailable" ? 503 : 403);
        expect(textOf(await response.text())).toContain(
          kind === "keys unavailable"
            ? ACCESS_UNAVAILABLE.title
            : kind === "another email"
              ? NOT_OWNER.title
              : ACCESS_REFUSED.title,
        );
        expect(await dump()).toEqual(before);
        expect(oauth.requests).toEqual([]);
      },
    );
  }

  it.each([null, "https://evil.example"])(
    "refuses page POSTs with Origin %s before any changes",
    async (origin) => {
      await pinOwner();
      const browser = new Browser();
      await browser.authenticate();
      const before = await dump();
      const mcp = new McpClient();
      for (const path of [
        await mcp.authorizePath(),
        "/connections/00000000-0000-4000-8000-000000000001/name",
        "/connections/00000000-0000-4000-8000-000000000001/revoke",
      ]) {
        expect(
          (await browser.post(path, { name: "New name", generation: "1" }, { origin })).status,
        ).toBe(403);
        expect(await dump()).toEqual(before);
      }
    },
  );

  it.each(["no cookie", "another browser", "another handle", "already used", "too old"])(
    "expires a consent with %s without creating another connection",
    async (kind) => {
      const clock = vi.spyOn(Date, "now").mockReturnValue(NOW);
      const mcp = new McpClient();
      await mcp.authorize();
      let response: Response;
      if (kind === "already used") {
        const fields = { ...mcp.form!.fields, name: "Work laptop", decision: "approve" };
        const cookies = new Map(
          [...mcp.browser.cookies].map(([origin, jar]) => [origin, new Map(jar)]),
        );
        await mcp.approve("Work laptop");
        await mcp.keepTokens(await mcp.exchange());
        // A queued double click still carries the original binding cookie.
        for (const [origin, jar] of cookies) mcp.browser.cookies.set(origin, jar);
        response = await mcp.browser.post("/authorize", fields);
      } else if (kind === "no cookie" || kind === "another browser") {
        const other = new Browser();
        await other.authenticate();
        if (kind === "another browser") {
          const otherConsent = new McpClient();
          await otherConsent.authorize();
          for (const [origin, jar] of otherConsent.browser.cookies)
            other.cookies.set(origin, new Map(jar));
        }
        response = await other.post("/authorize", {
          ...mcp.form!.fields,
          name: "Work laptop",
          decision: "approve",
        });
      } else if (kind === "another handle") {
        const other = new McpClient();
        await other.authorize();
        response = await mcp.consent("Work laptop", { handle: other.form!.fields.handle! });
      } else {
        clock.mockReturnValue(NOW + 601_000);
        await mcp.browser.authenticate();
        response = await mcp.consent("Work laptop");
      }
      await expired(response);
      expect(await rows()).toHaveLength(kind === "already used" ? 1 : 0);
    },
  );

  it("rechecks Access at submission even after the owner opened consent", async () => {
    const mcp = new McpClient();
    await mcp.authorize();
    const before = await dump();
    mcp.browser.assertion = await signAccessJwt({ exp: 1 });
    const response = await mcp.consent("Work laptop");
    expect(response.status).toBe(403);
    expect(textOf(await response.text())).toContain(ACCESS_REFUSED.title);
    expect(await dump()).toEqual(before);
  });

  it("shows the local app warning and creates only the named new connection at exchange", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const mcp = new McpClient();
    const { html } = await mcp.authorize();
    const text = textOf(html);
    for (const copy of [
      `Claude Code wants to connect to ${HOST}`,
      `Signed in as ${OWNER_EMAIL}`,
      "an app on this computer (localhost:3118)",
      codeClient.callback,
      "This connection gets no access to your Google accounts until you grant it on the Connections page.",
      "It stays connected until you revoke it or it goes unused for 90 days.",
      "Continue only if you just started signing in from Claude Code on this computer. Any program on this computer can claim to be Claude Code. If you did not start this, close this page.",
      "Connection name",
      "Connect",
      "Cancel",
    ])
      expect(text).toContain(copy);
    expect(mcp.form!.fields.name).toBe("Claude Code");
    const editable = [...html.matchAll(/<input\b([^>]*)>/g)].filter(
      (m) => !/type="hidden"/.test(m[1]!),
    );
    expect(editable).toHaveLength(1);
    expect(await rows()).toEqual([]);
    await mcp.approve("Work laptop");
    expect(await rows()).toEqual([]);
    await mcp.keepTokens(await mcp.exchange());
    const row = await onlyConnection();
    expect(row).toMatchObject({
      name: "Work laptop",
      app: "claude-code",
      state: "active",
      generation: 1,
      created_at: NOW,
      last_used_at: null,
      revoked_at: null,
    });
    expect(row.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(mcp.tokens!.access_token.split(":", 1)[0]).toBe(row.id);
    const state = await dump();
    for (const [table, entries] of Object.entries(state))
      if (/account|permission/i.test(table)) expect(entries).toEqual([]);
    expect(await (await mcp.call()).text()).toContain('"tools":[]');
  });

  it.each(["form", "query"])(
    "ignores forged app and connection values in the consent %s",
    async (source) => {
      const mcp = new McpClient();
      await mcp.authorize();
      const forged = {
        app: "chatgpt",
        connection: crypto.randomUUID(),
        connection_id: crypto.randomUUID(),
        client_id: clients[2].id,
        redirect_uri: "https://evil.example/callback",
      };
      if (source === "query")
        mcp.form = { ...mcp.form!, action: `/authorize?${new URLSearchParams(forged)}` };
      const response = await mcp.consent("Work laptop", source === "form" ? forged : {});
      expect(response.status).toBe(302);
      const callback = new URL(response.headers.get("Location")!);
      expect(`${callback.origin}${callback.pathname}`).toBe(codeClient.callback);
      mcp.code = callback.searchParams.get("code")!;
      await mcp.keepTokens(await mcp.exchange());
      const row = await onlyConnection();
      expect(row.app).toBe("claude-code");
      expect([forged.connection, forged.connection_id]).not.toContain(row.id);
    },
  );

  it.each([
    { label: "blank", name: "   \t\n" },
    { label: "over one hundred letters", name: "a".repeat(101) },
    { label: "over one hundred emoji", name: "😀".repeat(101) },
  ])("refuses a $label name and keeps the consent usable", async ({ name }) => {
    const mcp = new McpClient();
    const { html } = await mcp.authorize();
    const field = [...html.matchAll(/<input\b([^>]*)>/g)].find((m) =>
      /name="name"/.test(m[1]!),
    )?.[1];
    expect(field).toMatch(/(?:^|\s)required(?:=""|(?=\s|\/|$))/i);
    expect(field).toMatch(/maxlength="100"/i);
    expect((await mcp.consent(name)).status).toBe(400);
    expect(await rows()).toEqual([]);
    await mcp.approve("Work laptop");
    await mcp.keepTokens(await mcp.exchange());
    expect((await onlyConnection()).name).toBe("Work laptop");
  });

  it("trims and stores exactly one hundred Unicode code points including emoji", async () => {
    const name = `${"a".repeat(99)}😀`;
    await new McpClient().connect(`  ${name}  `);
    expect((await onlyConnection()).name).toBe(name);
  });

  it("shows database unavailable without a code when KV fails during approval", async () => {
    const mcp = new McpClient();
    await mcp.authorize();
    const response = await mcp.consent(
      "Work laptop",
      {},
      {
        env: testEnv({
          OAUTH_KV: new Proxy(env.OAUTH_KV, {
            get(target, key) {
              if (key === "put")
                return () => {
                  throw new Error("KV unavailable at completeAuthorization");
                };
              const value: unknown = Reflect.get(target, key);
              return typeof value === "function" ? value.bind(target) : value;
            },
          }),
        }),
      },
    );
    expect(response.status).toBe(503);
    expect(textOf(await response.text())).toContain(UNAVAILABLE.title);
    expect(response.headers.get("Location")).toBeNull();
    expect(await rows()).toEqual([]);
    expect((await kvDump()).filter((e) => e.name.startsWith("grant:"))).toEqual([]);
  });

  it.each(["GET", "approval"])(
    "reports an unreachable client document during %s without creating a grant",
    async (stage) => {
      const mcp = new McpClient();
      if (stage === "approval") await mcp.authorize();
      else await mcp.browser.authenticate();
      oauth.failedDocuments.add(codeClient.id);
      const response =
        stage === "GET" ? await mcp.browser.get(await mcp.authorizePath()) : await mcp.consent();
      expect(response.status).toBe(502);
      expect(response.headers.get("Content-Type")).toMatch(/^text\/plain/);
      expect(await response.text()).toBe(
        "Couldn't reach claude.ai. Nothing was connected. Try again from the app.",
      );
      expect(response.headers.get("Location")).toBeNull();
      expect(await rows()).toEqual([]);
      expect((await kvDump()).filter((e) => e.name.startsWith("grant:"))).toEqual([]);
    },
  );

  it("keeps two Claude Code laptops on the same callback port independently connected", async () => {
    const first = await new McpClient().connect("Work laptop");
    const second = await new McpClient().connect("Personal laptop");
    const all = await rows();
    expect(all).toHaveLength(2);
    expect(new Set(all.map((r) => r.id)).size).toBe(2);
    expect(new Set(all.map((r) => r.grant_id)).size).toBe(2);
    for (const client of [first, second]) {
      expect((await client.call()).status).toBe(200);
      await client.keepTokens(await client.refresh());
      expect((await client.call()).status).toBe(200);
    }
  });

  it("keeps the code retryable when connection statements fail at exchange", async () => {
    const mcp = new McpClient();
    await mcp.authorize();
    await mcp.approve();
    const grants = (await kvDump()).filter((e) => e.name.startsWith("grant:"));
    expect(grants).toHaveLength(1);
    await expectOAuthError(
      await mcp.exchange(testEnv({ DB: statementFailingDb(/connections/) })),
      "temporarily_unavailable",
    );
    expect((await kvDump()).filter((e) => e.name.startsWith("grant:"))).toEqual(grants);
    expect(await rows()).toEqual([]);
    await mcp.keepTokens(await mcp.exchange());
    expect(await rows()).toHaveLength(1);
  });

  it.each([false, true])(
    "deduplicates a committed exchange retry and refuses it if revoked is %s",
    async (revoked) => {
      const mcp = new McpClient();
      await mcp.authorize();
      await mcp.approve();
      await expectOAuthError(
        await mcp.exchange(testEnv({ DB: committedConnectionFailureDb() })),
        "temporarily_unavailable",
      );
      const row = await onlyConnection();
      if (revoked) {
        const staleGrant = await kvDump();
        const response = await mcp.browser.post(`/connections/${row.id}/revoke`);
        expect(response.status).toBe(200);
        await restoreKv(staleGrant);
        await expectOAuthError(await mcp.exchange(), "invalid_grant");
      } else {
        await mcp.keepTokens(await mcp.exchange());
        expect((await onlyConnection()).id).toBe(row.id);
      }
      expect(await rows()).toHaveLength(1);
    },
  );

  it("revokes a replayed code grant while leaving its connection active and last used unchanged", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(NOW);
    const mcp = await new McpClient().connect();
    expect((await mcp.call()).status).toBe(200);
    const row = await onlyConnection();
    expect(row.last_used_at).toBe(NOW);
    await expectOAuthError(await mcp.exchange(), "invalid_grant");
    clock.mockReturnValue(NOW + 10_000);
    expect((await mcp.call()).status).toBe(401);
    await expectOAuthError(await mcp.refresh(), "invalid_grant");
    expect(await onlyConnection()).toEqual(row);
    await new McpClient().connect();
    expect(await rows()).toHaveLength(2);
    expect(textOf(await (await mcp.browser.get("/connections")).text())).toContain("Active");
  });

  it("refuses an approved code from before reset after the owner pins again", async () => {
    const mcp = new McpClient();
    await mcp.authorize();
    await mcp.approve();
    await resetOwner();
    expect((await mcp.browser.get("/accounts")).status).toBe(200);
    await expectOAuthError(await mcp.exchange(), "invalid_grant");
    expect(await rows()).toEqual([]);
  });

  it("expires a consent page shown before reset when submission pins the owner again", async () => {
    const mcp = new McpClient();
    await mcp.authorize();
    expect(mcp.form!.fields.generation).toBe("1");
    await resetOwner();
    await expired(await mcp.consent());
    expect(await rows()).toEqual([]);
    expect((await kvDump()).filter((e) => e.name.startsWith("grant:"))).toEqual([]);
  });

  it.each(clients)(
    "allows only $label callback origin in consent CSP and cancels without a grant",
    async (client) => {
      const mcp = new McpClient(client);
      const { response, html } = await mcp.authorize();
      const csp = response.headers.get("Content-Security-Policy")!;
      expect(csp.split(";").map((s) => s.trim())).toContain(
        `form-action 'self' ${new URL(client.callback).origin}`,
      );
      expect(csp.split(";").map((s) => s.trim())).toContain("frame-ancestors 'none'");
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(response.headers.getSetCookie().join(";")).toMatch(
        /__Host-oauth-consent-[a-f0-9]{16}=/,
      );
      expect(html).not.toMatch(/<script\b/);
      if (client.app !== "claude-code")
        expect(textOf(html)).toContain(
          `Continue only if you just clicked Connect in ${client.label} yourself. If someone sent you this link, close this page.`,
        );
      const cancelled = await mcp.consent(undefined, { decision: "deny" });
      expect(cancelled.status).toBe(302);
      const target = new URL(cancelled.headers.get("Location")!);
      expect(`${target.origin}${target.pathname}`).toBe(client.callback);
      expect(target.searchParams.get("error")).toBe("access_denied");
      expect(target.searchParams.get("state")).toBe(mcp.state);
      expect(target.searchParams.has("code")).toBe(false);
      expect(await rows()).toEqual([]);
      expect((await kvDump()).filter((e) => e.name.startsWith("grant:"))).toEqual([]);
      const normal = await mcp.browser.get("/accounts");
      expect(normal.headers.get("Content-Security-Policy")).toBe(
        csp.replace(`form-action 'self' ${new URL(client.callback).origin}`, "form-action 'self'"),
      );
    },
  );
});

import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import OAuthProvider, { type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { expect, it, vi } from "vite-plus/test";
import { app } from "../src/http/app";
import { NOW, onlyConnection, seedConnection } from "./support/connections";
import { Browser } from "./support/browser";
import {
  committedConnectionFailureDb,
  dump,
  failingKv,
  kvDump,
  responseLostConnectionWriteDb,
  statementFailingDb,
} from "./support/db";
import { clients, expectOAuthError, McpClient, oauth } from "./support/oauth";
import { requests } from "./support/network";
import * as worker from "./support/worker";

// These are helper checks, not acceptance evidence: an isolated library host validates the
// client driver and msw setup now, before the production OAuth routes exist.
it.each(clients)(
  "validates the $label test driver against the pinned OAuth library",
  async (client) => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    type LibraryEnv = Env & { OAUTH_PROVIDER?: OAuthHelpers };
    const provider = new OAuthProvider<LibraryEnv>({
      apiRoute: "/mcp",
      resourceMetadata: { resource: `${worker.ORIGIN}/mcp` },
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/oauth/token",
      clientIdMetadataDocumentEnabled: true,
      apiHandler: { fetch: () => Response.json({ accepted: true }) },
      defaultHandler: {
        async fetch(request, libraryEnv) {
          const helpers = libraryEnv.OAUTH_PROVIDER!;
          if (request.method === "GET") {
            const auth = await helpers.parseAuthRequest(request);
            const { handle, headers } = await helpers.beginConsent(auth);
            return new Response(
              `<form action="/authorize" method="post"><input name="handle" value="${handle}" type="hidden"><input name="generation" value="1" type="hidden"><input name="name" value="${client.label}"></form>`,
              { headers },
            );
          }
          const form = await request.clone().formData();
          const handle = form.get("handle");
          if (typeof handle !== "string") throw new Error("Missing test consent handle");
          const approved = await helpers.approveConsent(request, handle);
          const { redirectTo } = await helpers.completeAuthorization({
            request: approved.request,
            userId: crypto.randomUUID(),
            scope: approved.request.scope,
            metadata: {},
            props: {},
            revokeExistingGrants: false,
          });
          const headers = new Headers(approved.headers);
          headers.set("Location", redirectTo);
          return new Response(null, { status: 302, headers });
        },
      },
    });
    vi.spyOn(worker, "callWorker").mockImplementation(
      async (request, workerEnv = worker.testEnv()) => {
        const ctx = createExecutionContext();
        const response = await provider.fetch(
          request,
          { ...workerEnv, OAUTH_PROVIDER: undefined },
          ctx,
        );
        await waitOnExecutionContext(ctx);
        return response;
      },
    );
    const mcp = await new McpClient(client).connect(undefined, "mcp offline_access");
    expect((await mcp.call()).status).toBe(200);
    await mcp.keepTokens(await mcp.refresh());
    expect(mcp.tokens!.scope).toBe("mcp offline_access");
    expect((await mcp.revoke()).status).toBe(200);
    expect((await mcp.call()).status).toBe(401);
    await expectOAuthError(await mcp.refresh(), "invalid_grant");
    expect(requests).toContain(client.id);
    if (client.app === "chatgpt")
      expect(oauth.requests).toContain("https://chatgpt.com/oauth/jwks.json");
  },
);

app.get("/__test/cookie-jar", (c) => {
  const headers = new Headers();
  const url = new URL(c.req.url);
  if (url.searchParams.has("set")) {
    headers.append(
      "Set-Cookie",
      "__Host-one=one; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600",
    );
    headers.append(
      "Set-Cookie",
      "__Host-two=two; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600",
    );
  }
  if (url.searchParams.has("clear"))
    headers.append("Set-Cookie", "__Host-one=; Path=/; Secure; Max-Age=0");
  return new Response(c.req.header("Cookie") ?? "", { headers });
});
it("keeps both binding cookies on their own origin and clears only the expired cookie", async () => {
  const browser = new Browser();
  await browser.get("/__test/cookie-jar?set");
  expect(await (await browser.get("/__test/cookie-jar")).text()).toBe(
    "__Host-one=one; __Host-two=two",
  );
  expect(await (await browser.get("https://other.example.com/__test/cookie-jar")).text()).toBe("");
  await browser.get("/__test/cookie-jar?clear");
  expect(await (await browser.get("/__test/cookie-jar")).text()).toBe("__Host-two=two");
});

it("includes every KV value in unchanged-state checks", async () => {
  await env.OAUTH_KV.put("first", "one", { metadata: { kind: "test" } });
  const before = await dump();
  await env.OAUTH_KV.put("first", "two", { metadata: { kind: "test" } });
  expect(await dump()).not.toEqual(before);
  expect(await kvDump()).toEqual([{ name: "first", value: "two", metadata: { kind: "test" } }]);
});

it("fails every KV method or only token writes as selected", async () => {
  const all = failingKv("all");
  for (const operation of [
    () => all.get("key"),
    () => all.put("key", "value"),
    () => all.delete("key"),
    () => all.getWithMetadata("key"),
    () => all.list(),
  ])
    expect(operation).toThrow("KV unavailable");
  const token = failingKv("token-put");
  await token.put("grant:test", "retained");
  expect(await token.get("grant:test")).toBe("retained");
  expect(() => token.put("token:test", "value")).toThrow("KV unavailable");
});

it("injects a connection failure without breaking the owner read", async () => {
  const db = statementFailingDb(/connections/);
  expect(await db.prepare("SELECT state FROM owner WHERE id = 1").first()).toEqual({
    state: "unpinned",
  });
  await expect(db.prepare("SELECT * FROM connections").all()).rejects.toThrow("D1_ERROR");
});
it("can lose the D1 answer after a real connection write committed", async () => {
  const row = await seedConnection();
  const lost = responseLostConnectionWriteDb();
  await expect(
    lost
      .prepare("UPDATE connections SET name = ? WHERE id = ?")
      .bind("Personal laptop", row.id)
      .run(),
  ).rejects.toThrow("response lost after commit");
  expect((await onlyConnection()).name).toBe("Personal laptop");
  const id = crypto.randomUUID();
  const db = committedConnectionFailureDb();
  const insert = db
    .prepare(
      "INSERT INTO connections SELECT ?, generation, ?, app, name, state, created_at, expires_at, last_used_at, revoked_at FROM connections WHERE id = ?",
    )
    .bind(id, crypto.randomUUID(), row.id);
  await expect(db.batch([insert])).rejects.toThrow("response lost after commit");
  expect(await env.DB.prepare("SELECT id FROM connections WHERE id = ?").bind(id).first()).toEqual({
    id,
  });
});

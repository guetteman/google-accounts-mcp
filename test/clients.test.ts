import { createExecutionContext } from "cloudflare:test";
import { withClientFilter } from "../src/oauth/clients";
import { describe, expect, it } from "vite-plus/test";
import { http, HttpResponse } from "msw";
import { signAccessJwt } from "./support/access";
import { Browser } from "./support/browser";
import { brokenDb, dump, kvDump } from "./support/db";
import { network, requests } from "./support/network";
import {
  clients,
  codeClient,
  expectOAuthError,
  McpClient,
  unsignedAssertion,
  signClientAssertion,
} from "./support/oauth";
import { callWorker, ORIGIN, testEnv, textOf } from "./support/worker";

const refused = async (response: Response) => {
  expect(response.status).toBe(400);
  expect(response.headers.get("Location")).toBeNull();
  const text = textOf(await response.text());
  expect(text).toContain("This app can't connect");
  expect(text).toContain(
    "Only Claude, Claude Code, and ChatGPT can connect to this server. Nothing changed.",
  );
};

describe("client checks before outbound requests", () => {
  it.each([codeClient.callback, "https://evil.example/callback"])(
    "refuses a second redirect_uri %s before fetching or writing",
    async (secondCallback) => {
      const mcp = new McpClient();
      await mcp.browser.authenticate();
      const url = new URL(await mcp.authorizePath());
      url.searchParams.append("redirect_uri", secondCallback);
      const before = await dump();
      await refused(await mcp.browser.get(url.href));
      expect(requests).toEqual([]);
      expect(await dump()).toEqual(before);
    },
  );

  it.each(["unlisted", "missing", "repeated"])(
    "refuses a %s authorization client before fetching even Access keys",
    async (kind) => {
      const before = await dump();
      network.use(
        http.get(/https:\/\/evil\.example\/.*/, () => new HttpResponse(null, { status: 404 })),
      );
      for (const assertion of [undefined, await signAccessJwt()]) {
        const client = new McpClient();
        const url = new URL(await client.authorizePath());
        url.searchParams.delete("client_id");
        if (kind === "unlisted")
          url.searchParams.append("client_id", `https://evil.example/${crypto.randomUUID()}.json`);
        if (kind === "repeated") {
          url.searchParams.append("client_id", codeClient.id);
          url.searchParams.append("client_id", codeClient.id);
        }
        const browser = new Browser();
        browser.assertion = assertion;
        await refused(await browser.get(url.href));
        expect(requests).toEqual([]);
        expect(await dump()).toEqual(before);
      }
    },
  );

  it.each(
    (
      [
        [clients[0], "http://localhost:3118/callback"],
        [clients[0], "http://127.0.0.1:51234/callback"],
        [clients[1], clients[1].callback],
        [clients[2], clients[2].callback],
      ] as const
    ).map(([client, callback]) => ({ client, label: client.label, callback })),
  )("opens consent for $label at $callback", async ({ client, callback }) => {
    const { html } = await new McpClient(client, ORIGIN, callback).authorize();
    expect(textOf(html)).toContain(`${client.label} wants to connect to accounts-mcp.example.com`);
  });

  it.each(
    (
      [
        [clients[0], "http://localhost:3118/other"],
        [clients[0], "http://localhost/callback"],
        [clients[0], "http://localhost:70000/callback"],
        [clients[0], "http://localhost:0/callback"],
        [clients[0], "http://evil.example/callback"],
        [clients[0], "http://evil.example:3118/callback"],
        [clients[0], "http://localhost:3118/callback?extra=1"],
        [clients[1], "http://localhost:3118/callback"],
      ] as const
    ).map(([client, callback]) => ({ client, label: client.label, callback })),
  )(
    "refuses $label callback $callback without fetching or writing",
    async ({ client, callback }) => {
      const browser = new Browser();
      await browser.authenticate();
      const before = await dump();
      await refused(
        await browser.get(await new McpClient(client, ORIGIN, callback).authorizePath()),
      );
      expect(requests).toEqual([]);
      expect(await dump()).toEqual(before);
    },
  );

  const invalidRequests = [
    "unlisted id",
    "unlisted assertion",
    "unlisted Basic",
    "allowed Basic",
    "Bearer header",
    "empty header",
    "empty id",
    "repeated id",
    "id plus empty id",
    "empty assertion",
    "repeated assertion",
    "assertion plus empty assertion",
    "repeated assertion type",
    "disagreeing clients",
    "unreadable issuer",
    "missing issuer",
    "no client",
    "JSON body",
    "multipart body",
  ];
  it.each(invalidRequests)(
    "refuses token authentication with %s without fetching or writing",
    async (kind) => {
      network.use(
        http.get(/https:\/\/evil\.example\/.*/, () => new HttpResponse(null, { status: 404 })),
      );
      const unknown = `https://evil.example/${crypto.randomUUID()}.json`;
      const assertion = unsignedAssertion({ iss: clients[2].id });
      for (const operation of ["authorization_code", "refresh_token", "revoke"]) {
        const body = new URLSearchParams(
          operation === "revoke"
            ? { token: "not-a-token" }
            : { grant_type: operation, code: "not-a-code", refresh_token: "not-a-token" },
        );
        const headers = new Headers({ "Content-Type": "application/x-www-form-urlencoded" });
        body.set("client_id", codeClient.id);
        if (kind === "unlisted id") body.set("client_id", unknown);
        if (kind === "unlisted assertion") {
          body.delete("client_id");
          body.set("client_assertion", unsignedAssertion({ iss: unknown }));
        }
        if (kind.includes("Basic")) {
          body.delete("client_id");
          headers.set(
            "Authorization",
            `Basic ${btoa(`${kind === "allowed Basic" ? codeClient.id : unknown}:secret`)}`,
          );
        }
        if (kind === "Bearer header") headers.set("Authorization", "Bearer ignored");
        if (kind === "empty header") headers.set("Authorization", "");
        if (kind === "empty id") body.set("client_id", "");
        if (kind === "repeated id") body.append("client_id", codeClient.id);
        if (kind === "id plus empty id") body.append("client_id", "");
        if (kind === "empty assertion") body.set("client_assertion", "");
        if (kind.includes("repeated assertion") || kind === "assertion plus empty assertion") {
          body.set("client_id", clients[2].id);
          body.set("client_assertion", assertion);
          body.set(
            "client_assertion_type",
            "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
          );
          body.append(
            kind === "repeated assertion type" ? "client_assertion_type" : "client_assertion",
            kind === "assertion plus empty assertion" ? "" : assertion,
          );
          if (kind === "repeated assertion type") body.append("client_assertion_type", "duplicate");
        }
        if (kind === "disagreeing clients") body.set("client_assertion", assertion);
        if (kind === "unreadable issuer") body.set("client_assertion", "a.b.c");
        if (kind === "missing issuer") {
          body.delete("client_id");
          body.set("client_assertion", unsignedAssertion({ sub: codeClient.id }));
        }
        if (kind === "no client") body.delete("client_id");
        if (kind === "JSON body") headers.set("Content-Type", "application/json");
        let requestBody: BodyInit =
          kind === "JSON body" ? JSON.stringify({ client_id: codeClient.id }) : body;
        if (kind === "multipart body") {
          headers.delete("Content-Type");
          const multipart = new FormData();
          body.forEach((value, key) => multipart.append(key, value));
          requestBody = multipart;
        }
        const before = await dump();
        const response = await callWorker(
          new Request(`${ORIGIN}/oauth/token`, {
            method: "POST",
            headers,
            body: requestBody,
          }),
        );
        await expectOAuthError(response, "invalid_client");
        expect(requests).toEqual([]);
        expect(await dump()).toEqual(before);
      }
    },
  );
});

it("does not register clients and requires a same-origin registration POST", async () => {
  const before = await dump();
  const browser = new Browser();
  expect((await browser.post("/register")).status).toBe(404);
  expect((await browser.post("/register", {}, { origin: null })).status).toBe(403);
  expect(await dump()).toEqual(before);
  expect(requests).toEqual([]);
});
it("advertises metadata documents without dynamic registration", async () => {
  const response = await new Browser().get("/.well-known/oauth-authorization-server");
  expect(response.status).toBe(200);
  const metadata = await response.json<Record<string, unknown>>();
  expect(metadata).not.toHaveProperty("registration_endpoint");
  expect(metadata.client_id_metadata_document_supported).toBe(true);
});

it.each(clients)(
  "exchanges refreshes and revokes $label tokens with its own client authentication",
  async (client) => {
    const mcp = await new McpClient(client).connect();
    await mcp.keepTokens(await mcp.refresh());
    expect((await mcp.call()).status).toBe(200);
    expect((await mcp.revoke()).status).toBe(200);
    expect((await mcp.call()).status).toBe(401);
    await expectOAuthError(await mcp.refresh(), "invalid_grant");
  },
);

for (const scope of [undefined, "mcp offline_access"]) {
  it.each(clients)(
    `keeps exactly the requested ${scope ?? "empty"} scope for $label across refreshes`,
    async (client) => {
      const mcp = await new McpClient(client).connect(undefined, scope);
      expect(mcp.tokens!.scope ?? "").toBe(scope ?? "");
      const grant = (await kvDump()).find((entry) => entry.name.startsWith("grant:"));
      expect(grant).toBeDefined();
      expect(JSON.parse(grant!.value!).scope).toEqual(scope ? scope.split(" ") : []);
      await mcp.keepTokens(await mcp.refresh(undefined, scope ?? ""));
      expect(mcp.tokens!.scope ?? "").toBe(scope ?? "");
      await expectOAuthError(await mcp.refresh(undefined, "ungranted"), "invalid_scope");
      if (scope) {
        await mcp.keepTokens(await mcp.refresh(undefined, "mcp ungranted"));
        expect(mcp.tokens!.scope).toBe("mcp");
        const retained = (await kvDump()).find((entry) => entry.name.startsWith("grant:"));
        expect(JSON.parse(retained!.value!).scope).toEqual(scope.split(" "));
      }
    },
  );
}

it("treats removed registration as a page when the owner gate refuses it", async () => {
  const response = await new Browser().post(
    "/register",
    {},
    { env: (await import("./support/worker")).testEnv({ DB: brokenDb() }) },
  );
  expect(response.status).toBe(503);
  expect(response.headers.get("Content-Type")).toContain("text/html");
  expect(textOf(await response.text())).toContain("The server can't reach its database");
});

describe("token request body limits", () => {
  it.each(["absent", "false", "correct"])(
    "stops an oversized unauthenticated stream with %s Content-Length before fetching or storing",
    async (length) => {
      const bytes = new TextEncoder().encode(
        `client_id=${encodeURIComponent(codeClient.id)}&padding=${"a".repeat(1024 * 1024)}`,
      );
      const before = await dump();
      let sent = 0;
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            if (sent === bytes.byteLength) return controller.close();
            // One byte beyond the boundary is enough to detect overflow. Do not drain it.
            const end =
              sent < 16 * 1024
                ? Math.min(sent + 1024, 16 * 1024)
                : Math.min(sent + (sent === 16 * 1024 ? 1 : 1024), bytes.byteLength);
            controller.enqueue(bytes.subarray(sent, end));
            sent = end;
          },
          cancel() {
            cancelled = true;
          },
        },
        { highWaterMark: 0 },
      );
      const headers = new Headers({ "Content-Type": "application/x-www-form-urlencoded" });
      if (length !== "absent")
        headers.set("Content-Length", length === "false" ? "1" : String(bytes.byteLength));
      const response = await callWorker(
        new Request(`${ORIGIN}/oauth/token`, { method: "POST", headers, body }),
      );
      expect(response.status).toBe(413);
      expect(sent).toBeLessThanOrEqual(16 * 1024 + 1);
      expect(cancelled).toBe(true);
      expect(requests).toEqual([]);
      expect(await dump()).toEqual(before);
    },
  );

  it.each(clients)(
    "passes byte-identical bounded $label bodies to the provider",
    async (client) => {
      const auth =
        client.app === "chatgpt"
          ? `client_assertion_type=urn%3Aietf%3Aparams%3Aoauth%3Aclient-assertion-type%3Ajwt-bearer&client_assertion=${await signClientAssertion()}`
          : `client_id=${encodeURIComponent(client.id)}`;
      for (const operation of [
        "grant_type=authorization_code&code=test",
        "grant_type=refresh_token&refresh_token=test",
        "token=test&token_type_hint=refresh_token",
      ]) {
        for (const size of [16 * 1024 - 1, 16 * 1024]) {
          const prefix = `${auth}&${operation}&extra=%f0%9f%98%80+%20&extra=&padding=`;
          const bytes = new TextEncoder().encode(prefix + "a".repeat(size - prefix.length));
          let received: Uint8Array | undefined;
          const filtered = withClientFilter(async (request) => {
            received = new Uint8Array(await request.arrayBuffer());
            return new Response(null, { status: 204 });
          });
          const response = await filtered(
            new Request(`${ORIGIN}/oauth/token`, {
              method: "POST",
              headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                "Content-Length": "1",
              },
              body: bytes,
            }),
            { ...testEnv(), ownerGeneration: 1 as import("../src/owner/owner").Generation },
            createExecutionContext(),
          );
          expect(response.status).toBe(204);
          expect(received).toEqual(bytes);
        }
      }
    },
  );
});

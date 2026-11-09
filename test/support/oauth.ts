import { expect } from "vite-plus/test";
import { http, HttpResponse } from "msw";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import codeDocument from "../fixtures/cimd/claude-code.json";
import hostedDocument from "../fixtures/cimd/claude-web.json";
import chatgptDocument from "../fixtures/cimd/chatgpt.json";
import { Browser, type RequestOptions } from "./browser";
import { callWorker, formsOf, ORIGIN, type HtmlForm, testEnv } from "./worker";

export const clients = [
  {
    app: "claude-code",
    label: "Claude Code",
    id: codeDocument.client_id,
    callback: "http://localhost:3118/callback",
  },
  {
    app: "claude-hosted",
    label: "Claude",
    id: hostedDocument.client_id,
    callback: hostedDocument.redirect_uris[0]!,
  },
  {
    app: "chatgpt",
    label: "ChatGPT",
    id: chatgptDocument.client_id,
    callback: chatgptDocument.redirect_uris[0]!,
  },
] as const;
export type Client = (typeof clients)[number];
export const codeClient = clients[0];
const documents = [codeDocument, hostedDocument, chatgptDocument];
const JWKS_URL = chatgptDocument.jwks_uri;
const keyId = "chatgpt-test-key";
let keys: ReturnType<typeof generateKeyPair> | undefined;
const testKeys = () => (keys ??= generateKeyPair("RS256", { extractable: true }));
export const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
export const unsignedAssertion = (claims: unknown) =>
  `e30.${b64url(new TextEncoder().encode(JSON.stringify(claims)))}.c2ln`;

export async function signClientAssertion(
  origin = ORIGIN,
  clientId: string = chatgptDocument.client_id,
) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256", kid: keyId })
    .setIssuer(clientId)
    .setSubject(clientId)
    .setAudience(`${origin}/oauth/token`)
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .setJti(crypto.randomUUID())
    .sign((await testKeys()).privateKey);
}

export const oauth = {
  requests: [] as string[],
  failedDocuments: new Set<string>(),
  reset() {
    this.requests.length = 0;
    this.failedDocuments.clear();
  },
  handlers() {
    return [
      ...documents.map((document) =>
        http.get(document.client_id, ({ request }) => {
          this.requests.push(request.url);
          return this.failedDocuments.has(document.client_id)
            ? new HttpResponse(null, { status: 503 })
            : HttpResponse.json(document, { headers: { "Cache-Control": "no-store" } });
        }),
      ),
      http.get(JWKS_URL, async ({ request }) => {
        this.requests.push(request.url);
        const jwk = await exportJWK((await testKeys()).publicKey);
        return HttpResponse.json({ keys: [{ ...jwk, kid: keyId, alg: "RS256", use: "sig" }] });
      }),
    ];
  },
};

export interface Tokens {
  access_token: string;
  refresh_token: string;
  scope?: string;
  token_type: string;
  expires_in: number;
}

/** HTTP-only MCP client. No provider helpers are used to create its grants or tokens. */
export class McpClient {
  readonly browser = new Browser();
  readonly verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  readonly state = crypto.randomUUID();
  code?: string;
  tokens?: Tokens;
  form?: HtmlForm;
  constructor(
    readonly client: Client = codeClient,
    readonly origin = ORIGIN,
    readonly callback: string = client.callback,
  ) {}

  async authorizePath(scope?: string): Promise<string> {
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(this.verifier));
    const query = new URLSearchParams({
      client_id: this.client.id,
      redirect_uri: this.callback,
      response_type: "code",
      code_challenge: b64url(new Uint8Array(hash)),
      code_challenge_method: "S256",
      state: this.state,
      resource: `${this.origin}/mcp`,
    });
    if (scope !== undefined) query.set("scope", scope);
    return `${this.origin}/authorize?${query}`;
  }

  async authorize(scope?: string): Promise<{ response: Response; html: string }> {
    await this.browser.authenticate();
    const response = await this.browser.get(await this.authorizePath(scope));
    expect(response.status, "accepted client must reach the consent page").toBe(200);
    const html = await response.text();
    const forms = formsOf(html);
    expect(forms, "consent page must contain its approval form").toHaveLength(1);
    this.form = forms[0]!;
    expect(this.form.fields).toHaveProperty("handle");
    expect(this.form.fields).toHaveProperty("generation");
    return { response, html };
  }

  async consent(
    name = this.client.label as string,
    extra: Record<string, string> = {},
    options: Omit<RequestOptions, "form" | "method"> = {},
  ) {
    expect(this.form, "authorize before submitting consent").toBeDefined();
    return this.browser.post(
      new URL(this.form!.action || "/authorize", this.origin).href,
      { ...this.form!.fields, name, decision: "approve", ...extra },
      options,
    );
  }

  async approve(name?: string) {
    const response = await this.consent(name);
    expect(response.status, "owner approval must redirect to the client").toBe(302);
    const target = new URL(response.headers.get("Location")!);
    expect(`${target.origin}${target.pathname}`).toBe(this.callback);
    expect(target.searchParams.get("state")).toBe(this.state);
    expect(target.searchParams.get("iss")).toBe(this.origin);
    expect(target.searchParams.get("code")).toBeTruthy();
    this.code = target.searchParams.get("code")!;
    return response;
  }

  async token(fields: Record<string, string>, workerEnv: Env = testEnv()) {
    const auth: Record<string, string> =
      this.client.app === "chatgpt"
        ? {
            client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
            client_assertion: await signClientAssertion(this.origin, this.client.id),
          }
        : { client_id: this.client.id };
    return callWorker(
      new Request(`${this.origin}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ ...auth, ...fields }),
      }),
      workerEnv,
    );
  }

  exchange(workerEnv?: Env) {
    expect(this.code).toBeTruthy();
    return this.token(
      {
        grant_type: "authorization_code",
        code: this.code!,
        redirect_uri: this.callback,
        code_verifier: this.verifier,
        resource: `${this.origin}/mcp`,
      },
      workerEnv,
    );
  }

  async keepTokens(response: Response) {
    expect(response.status, "token exchange or refresh must succeed").toBe(200);
    const tokens = await response.json<Tokens>();
    expect(tokens.access_token).toBeTruthy();
    expect(tokens.refresh_token).toBeTruthy();
    this.tokens = tokens;
    return tokens;
  }

  async connect(name?: string, scope?: string) {
    await this.authorize(scope);
    await this.approve(name);
    await this.keepTokens(await this.exchange());
    return this;
  }

  refresh(workerEnv?: Env, scope?: string) {
    expect(this.tokens).toBeDefined();
    return this.token(
      {
        grant_type: "refresh_token",
        refresh_token: this.tokens!.refresh_token,
        resource: `${this.origin}/mcp`,
        ...(scope === undefined ? {} : { scope }),
      },
      workerEnv,
    );
  }

  revoke() {
    expect(this.tokens).toBeDefined();
    return this.token({ token: this.tokens!.refresh_token, token_type_hint: "refresh_token" });
  }

  call(
    method = "tools/list",
    workerEnv: Env = testEnv(),
    params?: Record<string, unknown>,
    extra: Record<string, string> = {},
  ) {
    expect(this.tokens).toBeDefined();
    return callWorker(
      new Request(`${this.origin}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.tokens!.access_token}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": "2025-11-25",
          ...extra,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method,
          params:
            params ??
            (method === "initialize"
              ? {
                  protocolVersion: "2025-11-25",
                  capabilities: {},
                  clientInfo: { name: "acceptance-test", version: "1" },
                }
              : {}),
        }),
      }),
      workerEnv,
    );
  }
}

export async function expectOAuthError(
  response: Response,
  error: string,
  status = error === "temporarily_unavailable" ? 503 : error === "invalid_client" ? 401 : 400,
) {
  expect(response.status).toBe(status);
  expect(await response.json()).toMatchObject({ error });
}

export async function rpcResult(response: Response): Promise<Record<string, unknown>> {
  expect(response.status).toBe(200);
  const body = await response.text();
  const json = response.headers.get("Content-Type")?.includes("text/event-stream")
    ? body
        .split("\n")
        .find((line) => line.startsWith("data: "))
        ?.slice(6)
    : body;
  expect(json).toBeTruthy();
  const message = JSON.parse(json!) as { result?: Record<string, unknown>; error?: unknown };
  expect(message.error).toBeUndefined();
  expect(message.result).toBeDefined();
  return message.result!;
}

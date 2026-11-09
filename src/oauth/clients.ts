import type { App } from "../connections/model";
import type { GatedEnv } from "../owner/gate";

const clients = {
  "https://claude.ai/oauth/mcp-oauth-client-metadata": {
    app: "claude-hosted",
    label: "Claude",
    callback: "https://claude.ai/api/mcp/auth_callback",
  },
  "https://claude.ai/oauth/claude-code-client-metadata": {
    app: "claude-code",
    label: "Claude Code",
    callback: null,
  },
  "https://chatgpt.com/oauth/client.json": {
    app: "chatgpt",
    label: "ChatGPT",
    callback: "https://chatgpt.com/connector_platform_oauth_redirect",
  },
} as const;
function clientFor(id: string) {
  return Object.hasOwn(clients, id) ? clients[id as keyof typeof clients] : null;
}
export interface AcceptedClient {
  readonly app: App;
  readonly label: "Claude" | "Claude Code" | "ChatGPT";
  readonly callback: URL;
  readonly local: boolean;
}
export const appForClientId = (id: string): App | null => clientFor(id)?.app ?? null;
export function acceptAuthorize(clientId: string, redirectUri: string): AcceptedClient | null {
  const client = clientFor(clientId);
  if (!client) return null;
  if (client.callback === null) {
    const match = /^http:\/\/(localhost|127\.0\.0\.1):([0-9]+)\/callback$/.exec(redirectUri);
    if (!match || Number(match[2]) < 1 || Number(match[2]) > 65535) return null;
  } else if (redirectUri !== client.callback) return null;
  return {
    app: client.app,
    label: client.label,
    callback: new URL(redirectUri),
    local: client.callback === null,
  };
}
// This issuer only screens fetch destinations. The provider still verifies the signature.
function unverifiedIssuer(assertion: string): string | null {
  try {
    const parts = assertion.split(".");
    if (parts.length !== 3 || parts.some((p) => !p)) return null;
    const b64 = parts[1]!.replace(/-/g, "+").replace(/_/g, "/");
    const bytes = Uint8Array.from(
      atob(b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), "=")),
      (c) => c.charCodeAt(0),
    );
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return value !== null &&
      typeof value === "object" &&
      "iss" in value &&
      typeof value.iss === "string" &&
      value.iss.length > 0
      ? value.iss
      : null;
  } catch {
    return null;
  }
}
const invalidClient = () =>
  Response.json(
    { error: "invalid_client", error_description: "Client authentication failed" },
    { status: 401, headers: { "Cache-Control": "no-store", Pragma: "no-cache" } },
  );
export async function screenTokenRequest(request: Request): Promise<Response | null> {
  if (
    request.headers.has("Authorization") ||
    request.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase() !==
      "application/x-www-form-urlencoded"
  )
    return invalidClient();
  let form: FormData;
  try {
    form = await request.clone().formData();
  } catch {
    return invalidClient();
  }
  const ids = form.getAll("client_id");
  const assertions = form.getAll("client_assertion");
  if (
    ids.length > 1 ||
    assertions.length > 1 ||
    form.getAll("client_assertion_type").length > 1 ||
    ids[0] === "" ||
    assertions[0] === ""
  )
    return invalidClient();
  const id = ids[0];
  const issuer = typeof assertions[0] === "string" ? unverifiedIssuer(assertions[0]) : null;
  if ((assertions.length && !issuer) || (id !== undefined && issuer !== null && id !== issuer))
    return invalidClient();
  const client = id ?? issuer;
  return typeof client === "string" && appForClientId(client) ? null : invalidClient();
}
type Fetch = (
  request: Request,
  env: GatedEnv,
  ctx: ExecutionContext,
) => Response | Promise<Response>;
export const withClientFilter =
  (inner: Fetch): Fetch =>
  async (request, env, ctx) => {
    if (request.method === "POST" && new URL(request.url).pathname === "/oauth/token") {
      const refusal = await screenTokenRequest(request);
      if (refusal) return refusal;
    }
    return inner(request, env, ctx);
  };

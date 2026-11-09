import OAuthProvider, {
  OAuthError,
  type OAuthHelpers,
  type TokenExchangeCallbackOptions,
} from "@cloudflare/workers-oauth-provider";
import { Effect, Result } from "effect";
import { readConfig } from "../config";
import { decodeGrantProps, decodePendingGrant } from "../connections/model";
import { redeem, touchRefresh } from "../connections/store";
import { app } from "../http/app";
import { mcpHandler } from "../mcp/handler";
import type { GatedEnv } from "../owner/gate";
import { appForClientId } from "./clients";

export type OAuthEnv = GatedEnv & { OAUTH_PROVIDER?: OAuthHelpers };
const invalidGrant = () =>
  new OAuthError("invalid_grant", {
    description: "This connection is no longer active. Authorize again.",
  });
async function tokenExchangeCallback(options: TokenExchangeCallbackOptions<OAuthEnv>) {
  const { env, grantType, grantId, userId, clientId } = options;
  const props: unknown = options.props;
  const config = readConfig(env);
  if (Result.isFailure(config))
    throw new OAuthError("temporarily_unavailable", {
      description: "Server configuration unavailable",
      statusCode: 503,
    });
  const app = appForClientId(clientId);
  const grant = decodeGrantProps(props);
  if (!app || !grant || userId !== grant.connectionId) throw invalidGrant();
  const now = Date.now();
  let result: Result.Result<void, { readonly _tag: "Unavailable" | "NotActive" | "NotRedeemable" }>;
  if (grantType === "authorization_code") {
    const pending = decodePendingGrant(props);
    if (!pending) throw invalidGrant();
    result = await Effect.runPromise(
      Effect.result(
        redeem(env.DB, {
          props: pending,
          grantId,
          app,
          ownerEmail: config.success.ownerEmail,
          now,
        }),
      ),
    );
  } else if (grantType === "refresh_token") {
    result = await Effect.runPromise(
      Effect.result(
        touchRefresh(env.DB, {
          connectionId: grant.connectionId,
          grantId,
          ownerEmail: config.success.ownerEmail,
          now,
        }),
      ),
    );
  } else throw invalidGrant();
  if (Result.isFailure(result)) {
    if (result.failure._tag === "Unavailable")
      throw new OAuthError("temporarily_unavailable", {
        description: "Couldn't reach the database. Try again.",
        statusCode: 503,
      });
    throw invalidGrant();
  }
  return { newProps: grant };
}
const providers = new Map<string, OAuthProvider<OAuthEnv> | null>();
function providerFor(origin: string) {
  if (providers.has(origin)) return providers.get(origin)!;
  let provider: OAuthProvider<OAuthEnv> | null;
  // Plain HTTP on non-loopback hosts is for development page previews only.
  const url = new URL(origin);
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
  )
    provider = null;
  else
    provider = new OAuthProvider<OAuthEnv>({
      apiRoute: "/mcp",
      apiHandler: mcpHandler,
      defaultHandler: { fetch: app.fetch },
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/oauth/token",
      resourceMetadata: { resource: `${origin}/mcp` },
      clientIdMetadataDocumentEnabled: true,
      accessTokenTTL: 3600,
      refreshTokenTTL: 90 * 24 * 3600,
      refreshTokenIdleTTL: 90 * 24 * 3600,
      tokenExchangeCallback,
    });
  providers.set(origin, provider);
  return provider;
}
export const oauthServer = {
  async fetch(
    this: void,
    request: Request,
    env: GatedEnv,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    const provider = providerFor(url.origin);
    if (!provider) {
      if (
        url.pathname === "/authorize" ||
        url.pathname === "/mcp" ||
        url.pathname.startsWith("/mcp/") ||
        url.pathname.startsWith("/oauth/") ||
        url.pathname.startsWith("/.well-known/")
      )
        return new Response("Not found", { status: 404 });
      return app.fetch(request, env, ctx);
    }
    try {
      return await provider.fetch(request, { ...env, OAUTH_PROVIDER: undefined }, ctx);
    } catch (error) {
      if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/"))
        return new Response("Service unavailable", { status: 503 });
      if (url.pathname.startsWith("/oauth/"))
        return Response.json({ error: "temporarily_unavailable" }, { status: 503 });
      throw error;
    }
  },
};

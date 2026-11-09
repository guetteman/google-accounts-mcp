import { AuthorizationError, CimdFetchError } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import { newConnectionId, parseName, type PendingGrant } from "../connections/model";
import type { PageEnv } from "../http/context";
import { ownerOnly } from "../owner/routes";
import { renderPage } from "../pages/render";
import { acceptAuthorize } from "./clients";

export const consentRoutes = new Hono<PageEnv>();
const expired = () => renderPage({ _tag: "ConsentExpired" }, { status: 400 });
const refused = () => renderPage({ _tag: "ClientRefused" }, { status: 400 });
consentRoutes.get(
  "/authorize",
  async (c, next) => {
    const params = new URL(c.req.url).searchParams;
    if (
      params.getAll("client_id").length !== 1 ||
      params.getAll("redirect_uri").length !== 1 ||
      !acceptAuthorize(params.get("client_id")!, params.get("redirect_uri")!)
    )
      return refused();
    await next();
  },
  ownerOnly,
  async (c) => {
    const params = new URL(c.req.url).searchParams;
    const client = acceptAuthorize(params.get("client_id")!, params.get("redirect_uri")!)!;
    try {
      const helper = c.env.OAUTH_PROVIDER!;
      const request = await helper.parseAuthRequest(c.req.raw);
      const consent = await helper.beginConsent(request);
      return renderPage(
        {
          _tag: "Consent",
          host: new URL(c.req.url).host,
          ownerEmail: c.get("owner").email,
          client,
          handle: consent.handle,
          generation: c.get("owner").generation,
        },
        { headers: consent.headers, formAction: [client.callback.origin] },
      );
    } catch (error) {
      if (error instanceof CimdFetchError)
        return c.text(
          `Couldn't reach ${new URL(params.get("client_id")!).host}. Nothing was connected. Try again from the app.`,
          502,
        );
      if (error instanceof AuthorizationError) return refused();
      return renderPage({ _tag: "Unavailable" }, { status: 503 });
    }
  },
);
consentRoutes.post("/authorize", ownerOnly, async (c) => {
  const form = await c.req.raw.formData();
  if (form.get("generation") !== String(c.get("owner").generation)) return expired();
  const helper = c.env.OAUTH_PROVIDER!;
  const rawHandle = form.get("handle");
  const handle = typeof rawHandle === "string" ? rawHandle : "";
  const deny = form.get("decision") === "deny";
  const name = parseName(form.get("name"));
  if (!deny && !name) return c.text("Use a connection name with 1 to 100 characters.", 400);
  let clientHost: string | undefined;
  try {
    if (deny) {
      const denied = await helper.denyConsent(c.req.raw, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }
    const approved = await helper.approveConsent(c.req.raw, handle);
    const client = acceptAuthorize(approved.request.clientId, approved.request.redirectUri);
    if (!client) return refused();
    clientHost = new URL(approved.request.clientId).host;
    const connectionId = newConnectionId();
    const props: PendingGrant = {
      v: 1,
      connectionId,
      name: name!,
      generation: c.get("owner").generation,
    };
    const { redirectTo } = await helper.completeAuthorization({
      request: approved.request,
      userId: connectionId,
      metadata: {},
      scope: approved.request.scope,
      props,
      revokeExistingGrants: false,
    });
    const headers = new Headers(approved.headers);
    headers.set("Location", redirectTo);
    return new Response(null, { status: 302, headers });
  } catch (error) {
    if (error instanceof CimdFetchError && clientHost)
      return c.text(
        `Couldn't reach ${clientHost}. Nothing was connected. Try again from the app.`,
        502,
      );
    if (error instanceof AuthorizationError) return expired();
    return renderPage({ _tag: "Unavailable" }, { status: 503 });
  }
});

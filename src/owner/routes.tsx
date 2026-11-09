import { Effect, Result } from "effect";
import { Hono, type MiddlewareHandler } from "hono";
import { beginFlow } from "../google/flow";
import { authorizationUrl, pkceChallenge } from "../google/oauth";
import type { PageEnv } from "../http/context";
import { returnPath } from "../http/return-path";
import { randomToken } from "../lib/crypto";
import { renderPage } from "../pages/render";
import { readOwner } from "./owner";
import { requireOwner, sessionCookie, signOut, signOutEverywhere } from "./session";

export const ownerOnly: MiddlewareHandler<PageEnv> = async (c, next) => {
  const session = await Effect.runPromise(
    Effect.result(requireOwner(c.env.DB, c.get("config"), c.req.raw, Date.now())),
  );
  if (Result.isFailure(session)) {
    if (session.failure._tag === "Unavailable")
      return renderPage({ _tag: "Unavailable" }, { status: 503 });
    const url = new URL(c.req.url);
    const nextPath = returnPath(url.pathname + url.search, url.origin);
    if (c.req.method === "GET" || c.req.method === "HEAD")
      return c.redirect(`/signin?next=${encodeURIComponent(nextPath)}`, 302);
    return renderPage({ _tag: "SignIn", host: url.host, next: nextPath }, { status: 401 });
  }
  c.set("owner", session.success);
  await next();
};

export const ownerRoutes = new Hono<PageEnv>();
ownerRoutes.get("/", (c) => c.redirect("/accounts", 302));
ownerRoutes.get("/signin", async (c) => {
  const url = new URL(c.req.url);
  const next = returnPath(url.searchParams.get("next"), url.origin);
  const session = await Effect.runPromise(
    Effect.result(requireOwner(c.env.DB, c.get("config"), c.req.raw, Date.now())),
  );
  if (Result.isSuccess(session)) return c.redirect(next, 302);
  if (session.failure._tag === "Unavailable")
    return renderPage({ _tag: "Unavailable" }, { status: 503 });
  return renderPage({ _tag: "SignIn", host: url.host, next });
});
ownerRoutes.post("/signin", async (c) => {
  const url = new URL(c.req.url);
  const form = await c.req.parseBody();
  const next = returnPath(form.next, url.origin);
  const row = await Effect.runPromise(Effect.result(readOwner(c.env.DB)));
  if (Result.isFailure(row)) return renderPage({ _tag: "Unavailable" }, { status: 503 });
  const nonce = randomToken();
  const verifier = randomToken();
  const flow = beginFlow(
    { purpose: "owner-sign-in", nonce, verifier, next, generation: row.success.generation },
    Date.now(),
  );
  const target = authorizationUrl({
    clientId: c.get("config").google.clientId,
    redirectUri: `${url.origin}/google/callback`,
    scopes: ["openid", "email"],
    prompt: "select_account",
    state: flow.state,
    nonce,
    challenge: await pkceChallenge(verifier),
  });
  return new Response(null, {
    status: 302,
    headers: { Location: target.href, "Set-Cookie": flow.setCookie },
  });
});

for (const current of ["accounts", "connections"] as const) {
  ownerRoutes.get(`/${current}`, ownerOnly, (c) =>
    renderPage({
      _tag: current === "accounts" ? "Accounts" : "Connections",
      frame: { host: new URL(c.req.url).host, ownerEmail: c.get("config").ownerEmail, current },
    }),
  );
}
for (const [path, signout] of [
  ["/signout", signOut],
  ["/signout/all", signOutEverywhere],
] as const) {
  ownerRoutes.post(path, ownerOnly, async (c) => {
    const result = await Effect.runPromise(Effect.result(signout(c.env.DB, c.get("owner"))));
    if (Result.isFailure(result)) return renderPage({ _tag: "Unavailable" }, { status: 503 });
    return new Response(null, {
      status: 302,
      headers: { Location: "/signin", "Set-Cookie": sessionCookie(null) },
    });
  });
}

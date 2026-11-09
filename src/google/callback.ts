import { Effect, Result } from "effect";
import { Hono } from "hono";
import type { PageEnv } from "../http/context";
import { returnPath } from "../http/return-path";
import { NotOwner, signIn } from "../owner/owner";
import { sessionCookie } from "../owner/session";
import { renderPage } from "../pages/render";
import { clearFlowCookie, takeFlow } from "./flow";
import { checkIdToken, exchangeCode, ownerIdentity } from "./oauth";

export const callbackRoutes = new Hono<PageEnv>();
callbackRoutes.get("/google/callback", async (c) => {
  const url = new URL(c.req.url);
  const state = url.searchParams.get("state") ?? "";
  const taken = takeFlow(c.req.raw, state, Date.now());
  const clearCookie = clearFlowCookie(state);
  const finish = (response: Response) => {
    if (clearCookie) response.headers.append("Set-Cookie", clearCookie);
    return response;
  };
  const next = Result.isSuccess(taken) ? taken.success.next : returnPath(null, url.origin);
  const failed = () =>
    renderPage({ _tag: "SignIn", host: url.host, next, problem: "failed" }, { status: 400 });
  const code = url.searchParams.get("code");
  if (Result.isFailure(taken) || url.searchParams.has("error") || !code) return finish(failed());
  const flow = taken.success;
  const config = c.get("config");
  const result = await Effect.runPromise(
    Effect.result(
      Effect.gen(function* () {
        const tokens = yield* exchangeCode(
          config,
          code,
          flow.verifier,
          `${url.origin}/google/callback`,
        );
        const checked = checkIdToken(tokens.idToken, {
          clientId: config.google.clientId,
          nonce: flow.nonce,
          now: Date.now(),
        });
        if (Result.isFailure(checked))
          return yield* Effect.fail(new NotOwner({ email: checked.failure.email }));
        const who = ownerIdentity(checked.success, config);
        if (Result.isFailure(who)) return yield* Effect.fail(who.failure);
        return yield* signIn(c.env.DB, config, who.success, flow.generation, Date.now());
      }),
    ),
  );
  if (Result.isSuccess(result))
    return finish(
      new Response(null, {
        status: 302,
        headers: { Location: next, "Set-Cookie": sessionCookie(result.success) },
      }),
    );
  switch (result.failure._tag) {
    case "NotOwner":
      return finish(
        renderPage(
          { _tag: "NotOwner", host: url.host, address: result.failure.email, next },
          { status: 403 },
        ),
      );
    case "GoogleUnavailable":
      return finish(
        renderPage(
          { _tag: "SignIn", host: url.host, next, problem: "google-down" },
          { status: 502 },
        ),
      );
    case "Unavailable":
      return finish(renderPage({ _tag: "Unavailable" }, { status: 503 }));
    case "GoogleRefused":
    case "StaleFlow":
      return finish(failed());
  }
});

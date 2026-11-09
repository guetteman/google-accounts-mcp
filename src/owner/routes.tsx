import { Effect, Result } from "effect";
import { Hono, type MiddlewareHandler } from "hono";
import type { PageEnv } from "../http/context";
import { renderPage } from "../pages/render";
import { requireOwner } from "./owner";

export const ownerOnly: MiddlewareHandler<PageEnv> = async (c, next) => {
  const owner = await Effect.runPromise(
    Effect.result(
      requireOwner(c.env.DB, c.get("config"), c.env.ownerGeneration, c.req.raw, Date.now()),
    ),
  );
  if (Result.isFailure(owner)) {
    const host = new URL(c.req.url).host;
    switch (owner.failure._tag) {
      case "AccessMissing":
      case "AccessRejected":
        return renderPage({ _tag: "AccessRefused", host }, { status: 403 });
      case "AccessUnavailable":
        return renderPage({ _tag: "AccessUnavailable" }, { status: 503 });
      case "NotOwner":
        return renderPage(
          { _tag: "NotOwner", host, address: owner.failure.email },
          { status: 403 },
        );
      case "Locked":
        return renderPage({ _tag: "Mismatch" }, { status: 503 });
      case "Unavailable":
        return renderPage({ _tag: "Unavailable" }, { status: 503 });
    }
  }
  c.set("owner", owner.success);
  await next();
};

export const ownerRoutes = new Hono<PageEnv>();
ownerRoutes.get("/", ownerOnly, (c) => c.redirect("/accounts", 302));
ownerRoutes.get("/accounts", ownerOnly, (c) =>
  renderPage({
    _tag: "Accounts",
    frame: { host: new URL(c.req.url).host, ownerEmail: c.get("owner").email, current: "accounts" },
  }),
);

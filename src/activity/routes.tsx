import { Effect, Result } from "effect";
import { Hono } from "hono";
import type { PageEnv } from "../http/context";
import { ownerOnly } from "../owner/routes";
import { renderPage } from "../pages/render";
import { readActivity } from "./store";
import { parseActivityQuery } from "./query";

export const activityRoutes = new Hono<PageEnv>();
activityRoutes.get("/activity", ownerOnly, async (c) => {
  const owner = c.get("owner");
  const url = new URL(c.req.url);
  const query = parseActivityQuery(url.searchParams);
  const result = await Effect.runPromise(
    Effect.result(readActivity(c.env.DB, owner, query, Date.now())),
  );
  if (Result.isFailure(result)) return renderPage({ _tag: "Unavailable" }, { status: 503 });
  return renderPage({
    _tag: "Activity",
    frame: { host: url.host, ownerEmail: owner.email, current: "activity" },
    load: result.success,
    query,
  });
});

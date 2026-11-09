import { Result } from "effect";
import { Hono } from "hono";
import { readConfig } from "../config";
import { callbackRoutes } from "../google/callback";
import { ownerRoutes } from "../owner/routes";
import { renderPage } from "../pages/render";
import type { PageEnv } from "./context";
import { sameOrigin } from "./same-origin";

export const app = new Hono<PageEnv>();
app.use("*", sameOrigin);
app.use("*", async (c, next) => {
  const config = readConfig(c.env);
  if (Result.isFailure(config))
    return renderPage({ _tag: "SetupIncomplete", names: config.failure.names }, { status: 503 });
  c.set("config", config.success);
  await next();
});
app.route("/", ownerRoutes);
app.route("/", callbackRoutes);
if (import.meta.env.DEV) {
  const { previews } = await import("../pages/previews");
  app.get("/__pages/:id", (c) => {
    const page = previews[c.req.param("id")];
    return page ? renderPage(page) : c.notFound();
  });
}
app.notFound((c) => c.text("Not found", 404));
app.onError((error, c) => {
  console.error(error);
  return c.text("Internal server error", 500);
});

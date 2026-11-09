import { Result } from "effect";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { readConfig } from "../config";
import { consentRoutes } from "../oauth/consent";
import { connectionRoutes } from "../connections/routes";
import { ownerRoutes } from "../owner/routes";
import { renderPage } from "../pages/render";
import type { PageEnv } from "./context";
import { MAX_BODY_BYTES } from "./body-limit";
import { sameOrigin } from "./same-origin";

export const app = new Hono<PageEnv>();
app.use("*", sameOrigin);
app.use("*", (c, next) => {
  // Hono otherwise trusts Content-Length instead of measuring the streamed bytes.
  c.req.raw = new Request(c.req.raw);
  c.req.raw.headers.delete("Content-Length");
  return next();
});
app.use(
  "*",
  bodyLimit({
    maxSize: MAX_BODY_BYTES, // Cap every page action before handlers read the body.
    onError: (c) => c.text("Payload too large", 413),
  }),
);
app.use("*", async (c, next) => {
  const config = readConfig(c.env);
  if (Result.isFailure(config))
    return renderPage({ _tag: "SetupIncomplete", names: config.failure.names }, { status: 503 });
  c.set("config", config.success);
  await next();
});
app.route("/", consentRoutes);
app.route("/", connectionRoutes);
app.route("/", ownerRoutes);
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

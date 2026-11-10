import { createMiddleware } from "hono/factory";
import type { PageEnv } from "./context";

/** Refuse malformed form bodies before an owner action can write. */
export const readForm = createMiddleware<PageEnv>(async (c, next) => {
  try {
    c.set("form", await c.req.raw.formData());
  } catch {
    return c.json({ outcome: "invalid" }, 400);
  }
  await next();
});

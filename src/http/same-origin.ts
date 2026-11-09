import type { MiddlewareHandler } from "hono";

export const sameOrigin: MiddlewareHandler = async (c, next) => {
  const request = c.req.raw;
  if (
    request.method !== "GET" &&
    request.method !== "HEAD" &&
    request.headers.get("Origin") !== new URL(request.url).origin
  ) {
    return c.text("Forbidden", 403);
  }
  await next();
};

import { Effect, Result } from "effect";
import { readConfig } from "../config";
import type { Page } from "../pages/page";
import { renderPage } from "../pages/render";
import { isLocked, readOwner, type Generation } from "./owner";

export type GatedEnv = Env & { readonly ownerGeneration: Generation };

type Fetch = (
  request: Request,
  env: GatedEnv,
  ctx: ExecutionContext,
) => Response | Promise<Response>;

function refuse(request: Request, page: Page): Response {
  const path = new URL(request.url).pathname;
  if (path.startsWith("/uploads/"))
    return Response.json(
      {
        code: "server_unavailable",
        message: "The server is unavailable. The owner must check its setup.",
      },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  if (path === "/mcp") return new Response("Service unavailable", { status: 503 });
  if (path.startsWith("/oauth/") || path.startsWith("/.well-known/")) {
    return Response.json({ error: "temporarily_unavailable" }, { status: 503 });
  }
  return renderPage(page, { status: 503 });
}

export const withOwnerGate =
  (inner: Fetch) =>
  async (request: Request, env: Env, ctx: ExecutionContext): Promise<Response> => {
    const config = readConfig(env);
    if (Result.isFailure(config))
      return refuse(request, { _tag: "SetupIncomplete", names: config.failure.names });
    const owner = await Effect.runPromise(Effect.result(readOwner(env.DB)));
    if (Result.isFailure(owner)) return refuse(request, { _tag: "Unavailable" });
    if (isLocked(owner.success, config.success)) return refuse(request, { _tag: "Mismatch" });
    return inner(request, { ...env, ownerGeneration: owner.success.generation }, ctx);
  };

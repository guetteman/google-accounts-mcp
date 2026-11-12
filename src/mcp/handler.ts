import { createMcpHandler } from "@modelcontextprotocol/server";
import { Effect, Result } from "effect";
import { readConfig } from "../config";
import { decodeGrantProps } from "../connections/model";
import { touchCall } from "../connections/store";
import type { GatedEnv } from "../owner/gate";
import type { CallContext } from "./call";
import { watchToolList } from "./watch";
import { createMcpServer } from "./server";

function inactive(request: Request) {
  return new Response(null, {
    status: 401,
    headers: {
      "WWW-Authenticate": `Bearer realm="OAuth", error="invalid_token", resource_metadata="${new URL(request.url).origin}/.well-known/oauth-protected-resource/mcp"`,
      "Cache-Control": "no-store",
    },
  });
}
export const mcpHandler = {
  async fetch(request: Request, env: GatedEnv, ctx: ExecutionContext): Promise<Response> {
    const props = decodeGrantProps(ctx.props);
    if (!props) return inactive(request);
    const config = readConfig(env);
    if (Result.isFailure(config)) return new Response("Service unavailable", { status: 503 });
    const connection = await Effect.runPromise(
      Effect.result(
        touchCall(env.DB, {
          connectionId: props.connectionId,
          ownerEmail: config.success.ownerEmail,
          now: Date.now(),
        }),
      ),
    );
    if (Result.isFailure(connection))
      return connection.failure._tag === "NotActive"
        ? inactive(request)
        : new Response("Service unavailable", { status: 503 });
    const context: CallContext = {
      db: env.DB,
      config: config.success,
      connection: connection.success,
      owner: { generation: env.ownerGeneration, email: config.success.ownerEmail },
      origin: new URL(request.url).origin,
      now: Date.now,
      waitUntil: (work) => ctx.waitUntil(work),
    };
    const handler = createMcpHandler(() => createMcpServer(context), {
      bus: watchToolList(context, () => void handler.close()),
    });
    return handler.fetch(request);
  },
};

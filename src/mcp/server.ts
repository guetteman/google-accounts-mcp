import {
  CLIENT_INFO_META_KEY,
  ProtocolError,
  ProtocolErrorCode,
  Server,
  type Tool as McpTool,
} from "@modelcontextprotocol/server";
import { Effect, Result, Schema } from "effect";
import { runCall, type CallContext } from "./call";
import { listedTools } from "./tools";
export function createMcpServer(ctx: CallContext): Server {
  const server = new Server(
    { name: "google-accounts-mcp", version: "0.0.0" },
    { capabilities: { tools: { listChanged: true } } },
  );
  server.setRequestHandler("tools/list", async () => {
    const listed = await Effect.runPromise(Effect.result(listedTools(ctx)));
    if (Result.isFailure(listed))
      throw new ProtocolError(
        ProtocolErrorCode.InternalError,
        "The server could not read the tool list. Try again later.",
      );
    return {
      tools: listed.success.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        annotations: { readOnlyHint: true },
        // Effect's empty struct is not an object JSON Schema. Keep the existing contract.
        inputSchema:
          tool.kind === "plain"
            ? (tool.inputSchema ?? { type: "object", properties: {} })
            : (Schema.toJsonSchemaDocument(tool.input).schema as McpTool["inputSchema"]),
      })),
    };
  });
  server.setRequestHandler("tools/call", (request, extra) => {
    // SDK 2.3.0 types the envelope as {}; older requests can carry unvalidated metadata.
    const envelope: { [CLIENT_INFO_META_KEY]?: { name?: unknown } } | undefined =
      extra.mcpReq.envelope;
    const stated = envelope?.[CLIENT_INFO_META_KEY]?.name;
    const client =
      ctx.connection.app === "claude-code"
        ? "claude-code"
        : ctx.connection.app === "claude-hosted" && typeof stated === "string"
          ? stated
          : null;
    return runCall({ ...ctx, reader: { client } }, request.params.name, request.params.arguments);
  });
  return server;
}

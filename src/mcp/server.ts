import { Server, type Tool as McpTool } from "@modelcontextprotocol/server";
import { Schema } from "effect";
import { runCall, type CallContext } from "./call";
import { TOOLS } from "./tools";
export function createMcpServer(ctx: CallContext): Server {
  const server = new Server(
    { name: "google-accounts-mcp", version: "0.0.0" },
    { capabilities: { tools: { listChanged: false } } },
  );
  server.setRequestHandler("tools/list", () => ({
    tools: TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      annotations: { readOnlyHint: true },
      // Effect's empty struct is not an object JSON Schema. Keep the existing contract.
      inputSchema:
        tool.kind === "plain"
          ? { type: "object", properties: {} }
          : (Schema.toJsonSchemaDocument(tool.input).schema as McpTool["inputSchema"]),
    })),
  }));
  server.setRequestHandler("tools/call", (request) =>
    runCall(ctx, request.params.name, request.params.arguments),
  );
  return server;
}

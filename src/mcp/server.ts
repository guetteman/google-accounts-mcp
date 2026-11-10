import { McpServer } from "@modelcontextprotocol/server";
import type { ActiveConnection } from "../connections/model";

// The connection identity is checked in D1. #15 adds permission checks and tool call records.
export function createMcpServer(_connection: ActiveConnection): McpServer {
  const server = new McpServer(
    { name: "google-accounts-mcp", version: "0.0.0" },
    { capabilities: { tools: { listChanged: false } } },
  );
  server.registerTool(
    "list_accounts",
    {
      description:
        "Lists the Google accounts this connection can use, as a JSON array. An empty array means the owner has not given this connection access to any account.",
      annotations: { readOnlyHint: true },
    },
    () => ({ content: [{ type: "text", text: "[]" }] }),
  );
  return server;
}

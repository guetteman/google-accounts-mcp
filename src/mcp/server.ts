import { McpServer } from "@modelcontextprotocol/server";
import type { ActiveConnection } from "../connections/model";

// #11 registers tools here, with the identity just checked in D1.
export function createMcpServer(_connection: ActiveConnection): McpServer {
  return new McpServer(
    { name: "google-accounts-mcp", version: "0.0.0" },
    { capabilities: { tools: {} } },
  );
}

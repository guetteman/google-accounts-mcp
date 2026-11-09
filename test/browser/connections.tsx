import { createRoot } from "react-dom/client";
import { ConnectionsPage } from "../../src/pages/connections";
import { parseConnectionId } from "../../src/connections/model";
import "../../src/styles.css";

createRoot(document.getElementById("root")!).render(
  <ConnectionsPage
    frame={{
      host: "accounts-mcp.example.com",
      ownerEmail: "owner@example.com",
      current: "connections",
    }}
    connections={[
      {
        id: parseConnectionId("11111111-1111-4111-8111-111111111111")!,
        name: "Work laptop",
        appLabel: "Claude Code",
        status: { kind: "active" },
        created: "Nov 1",
        lastUsed: "Never",
      },
    ]}
    mcpUrl="https://accounts-mcp.example.com/mcp"
  />,
);

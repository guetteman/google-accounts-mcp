import { createRoot } from "react-dom/client";
import { ConsentPage } from "../../src/pages/consent";
import { acceptAuthorize } from "../../src/oauth/clients";
import { ConnectionsPage } from "../../src/pages/connections";
import { parseConnectionId } from "../../src/connections/model";
import "../../src/styles.css";

createRoot(document.getElementById("root")!).render(
  location.pathname === "/consent" ? (
    <ConsentPage
      _tag="Consent"
      host="accounts-mcp.example.com"
      ownerEmail="owner@example.com"
      client={acceptAuthorize(
        "https://claude.ai/oauth/claude-code-client-metadata",
        "http://localhost:3118/callback",
      )!}
      handle="test-consent"
      generation={1 as import("../../src/owner/owner").Generation}
    />
  ) : (
    <ConnectionsPage
      frame={{
        host: "accounts-mcp.example.com",
        ownerEmail: "owner@example.com",
        current: "connections",
      }}
      connections={[
        {
          id: parseConnectionId("22222222-2222-4222-8222-222222222222")!,
          name: "Other laptop",
          appLabel: "Claude Code",
          status: { kind: "active" },
          created: "Nov 2",
          lastUsed: "Never",
        },
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
    />
  ),
);

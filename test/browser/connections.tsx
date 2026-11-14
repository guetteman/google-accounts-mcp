import { createRoot } from "react-dom/client";
import { ConsentPage } from "../../src/pages/consent";
import { acceptAuthorize } from "../../src/oauth/clients";
import { ConnectionPage } from "../../src/pages/connection";
import { connectionPage } from "../support/connection-page";
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
    <ConnectionPage
      {...connectionPage}
      connection={{ ...connectionPage.connection, name: "Work laptop", appLabel: "Claude Code" }}
    />
  ),
);

import { createRoot } from "react-dom/client";
import { ConsentPage } from "../../src/pages/consent";
import { acceptAuthorize } from "../../src/oauth/clients";
import type { ComponentType } from "react";
import { connectionPage } from "../support/connection-page";
const modules = import.meta.glob<{ ConnectionPage: ComponentType<typeof connectionPage> }>(
  "../../src/pages/connection.tsx",
);
const load = modules["../../src/pages/connection.tsx"];
const ConnectionPage = load
  ? (await load()).ConnectionPage
  : () => <p>The accepted ConnectionPage component is not implemented.</p>;
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

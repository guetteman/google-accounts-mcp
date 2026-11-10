import { createRoot } from "react-dom/client";
import { AccountsPage } from "../../src/pages/accounts";
import type { AccountView } from "../../src/accounts/model";
import type { AccountsAlert } from "../../src/accounts/flow";
import type { Frame } from "../../src/pages/page";
import "../../src/styles.css";
const props = {
  requiredGmailScopes: Number(new URLSearchParams(location.search).get("required") ?? 5),
  frame: {
    host: "accounts-mcp.example.com",
    ownerEmail: "owner@example.com",
    current: "accounts",
  } as Frame,
  accounts: [
    {
      id: "11111111-1111-4111-8111-111111111111" as AccountView["id"],
      name: "Personal",
      email: "alex.personal@example.com",
      workspace: false,
      status: { kind: "ready" as const },
    },
    {
      id: "22222222-2222-4222-8222-222222222222" as AccountView["id"],
      name: "Projects",
      email: "alex.projects@example.com",
      workspace: false,
      status: { kind: "needs_reconnect" as const },
    },
    {
      id: "33333333-3333-4333-8333-333333333333" as AccountView["id"],
      name: "Work",
      email: "alex@harbor.example",
      workspace: true,
      status: { kind: "blocked_by_admin" as const },
    },
    {
      id: "44444444-4444-4444-8444-444444444444" as AccountView["id"],
      name: "Research",
      email: "research@example.com",
      workspace: false,
      status: { kind: "missing_access" as const, granted: 2 },
    },
    {
      id: "55555555-5555-4555-8555-555555555555" as AccountView["id"],
      name: "Recovery",
      email: "recovery@example.com",
      workspace: false,
      status: { kind: "unreadable" as const },
    },
  ],
  alert: (() => {
    const kind = new URLSearchParams(location.search).get("alert");
    return kind
      ? ({
          kind,
          address: "alex.personal@example.com",
          name: "Personal",
          target: "alex@harbor.example",
          signedIn: "research@example.com",
        } as AccountsAlert)
      : null;
  })(),
};
createRoot(document.getElementById("root")!).render(<AccountsPage {...props} />);

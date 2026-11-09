import { createRoot } from "react-dom/client";
import { AccountsPage } from "../../src/pages/accounts";
import type { AccountView } from "../../src/accounts/model";
import type { Frame } from "../../src/pages/page";
import "../../src/styles.css";
const props = {
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
  ],
  alert: null,
};
createRoot(document.getElementById("root")!).render(<AccountsPage {...props} />);

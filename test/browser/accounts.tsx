import { createRoot } from "react-dom/client";
import { AccountsPage } from "../../src/pages/accounts";
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
      id: "11111111-1111-4111-8111-111111111111",
      name: "Personal",
      email: "alex.personal@example.com",
      workspace: false,
      status: { kind: "ready" },
    },
  ],
  alert: null,
};
createRoot(document.getElementById("root")!).render(<AccountsPage {...props} />);

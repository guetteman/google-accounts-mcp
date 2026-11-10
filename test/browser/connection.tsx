import { createRoot } from "react-dom/client";
import type { ComponentType } from "react";
import { connectionPage } from "../support/connection-page";
import "../../src/styles.css";

const modules = import.meta.glob<{ ConnectionPage: ComponentType<typeof connectionPage> }>(
  "../../src/pages/connection.tsx",
);
const load = modules["../../src/pages/connection.tsx"];
if (load) {
  const { ConnectionPage } = await load();
  createRoot(document.getElementById("root")!).render(<ConnectionPage {...connectionPage} />);
} else {
  document.getElementById("root")!.textContent =
    "The accepted ConnectionPage component is not implemented.";
}

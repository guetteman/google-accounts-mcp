import { createRoot } from "react-dom/client";
import type { ComponentType } from "react";
import { connectionPage, groupedConnectionPage } from "../support/connection-page";
import type { FramePage } from "../../src/pages/page";
import "../../src/styles.css";

const modules = import.meta.glob<{
  ConnectionPage: ComponentType<Extract<FramePage, { _tag: "Connection" }>>;
}>("../../src/pages/connection.tsx");
const load = modules["../../src/pages/connection.tsx"];
if (load) {
  const { ConnectionPage } = await load();
  const props = new URLSearchParams(location.search).has("groups")
    ? groupedConnectionPage
    : connectionPage;
  createRoot(document.getElementById("root")!).render(<ConnectionPage {...props} />);
} else {
  document.getElementById("root")!.textContent =
    "The accepted ConnectionPage component is not implemented.";
}

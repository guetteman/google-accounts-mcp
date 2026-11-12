import { createRoot } from "react-dom/client";
import type { ComponentType } from "react";
import {
  connectionPage,
  groupedConnectionPage,
  irreversibleConnectionPage,
} from "../support/connection-page";
import type { FramePage } from "../../src/pages/page";
import "../../src/styles.css";

const modules = import.meta.glob<{
  ConnectionPage: ComponentType<Extract<FramePage, { _tag: "Connection" }>>;
}>("../../src/pages/connection.tsx");
const load = modules["../../src/pages/connection.tsx"];
if (load) {
  const { ConnectionPage } = await load();
  const query = new URLSearchParams(location.search);
  // "tools" carries the server's real tool list, as the connection's route gives it to the page.
  const tools = query.get("tools");
  const props = tools
    ? { ...connectionPage, tools: JSON.parse(tools) as (typeof groupedConnectionPage)["tools"] }
    : query.has("irreversible")
      ? irreversibleConnectionPage
      : query.has("groups")
        ? groupedConnectionPage
        : connectionPage;
  createRoot(document.getElementById("root")!).render(<ConnectionPage {...props} />);
} else {
  document.getElementById("root")!.textContent =
    "The accepted ConnectionPage component is not implemented.";
}

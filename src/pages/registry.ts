import { createElement } from "react";
import { AccountsPage } from "./accounts";
import { ConnectionsPage } from "./connections";
import type { FramePage } from "./page";

// Both SSR and hydration select the same component without importing the server renderer.
export const frameElement = (page: FramePage) =>
  page._tag === "Accounts"
    ? createElement(AccountsPage, page)
    : createElement(ConnectionsPage, {
        frame: page.frame,
        connections: page.connections,
        mcpUrl: page.mcpUrl,
      });

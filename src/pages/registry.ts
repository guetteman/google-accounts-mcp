import { createElement } from "react";
import { AccountsPage } from "./accounts";
import { ConnectionsPage } from "./connections";
import { ConnectionPage } from "./connection";
import type { FramePage } from "./page";
// SSR and hydration must select the same component for every frame page.
export const frameElement = (page: FramePage) => {
  switch (page._tag) {
    case "Accounts":
      return createElement(AccountsPage, page);
    case "Connections":
      return createElement(ConnectionsPage, page);
    case "Connection":
      return createElement(ConnectionPage, page);
  }
};

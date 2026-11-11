import { ApprovalPage } from "./approval";
import { createElement } from "react";
import { AccountsPage } from "./accounts";
import { ConnectionsPage } from "./connections";
import { ConnectionPage } from "./connection";
import type { HydratedPage } from "./page";
// SSR and hydration must select the same component for every hydrated page.
export const hydratedElement = (page: HydratedPage) => {
  switch (page._tag) {
    case "Approval":
      return createElement(ApprovalPage, page);
    case "Accounts":
      return createElement(AccountsPage, page);
    case "Connections":
      return createElement(ConnectionsPage, page);
    case "Connection":
      return createElement(ConnectionPage, page);
  }
};

import type { Page } from "./page";

const host = "accounts-mcp.example.com";
export const previews: Readonly<Record<string, Page>> = {
  "access-refused": { _tag: "AccessRefused", host },
  "access-unavailable": { _tag: "AccessUnavailable" },
  "not-owner": { _tag: "NotOwner", host, address: "someone.else@example.net" },
  mismatch: { _tag: "Mismatch" },
  "setup-incomplete": { _tag: "SetupIncomplete", names: ["ACCESS_AUDIENCE"] },
  "setup-incomplete-two": { _tag: "SetupIncomplete", names: ["OWNER_EMAIL", "ACCESS_ISSUER"] },
  unavailable: { _tag: "Unavailable" },
  accounts: {
    _tag: "Accounts",
    frame: { host, ownerEmail: "owner@example.com", current: "accounts" },
  },
  connections: {
    _tag: "Connections",
    frame: { host, ownerEmail: "owner@example.com", current: "connections" },
  },
};

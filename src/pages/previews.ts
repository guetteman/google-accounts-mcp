import type { Page } from "./page";

const host = "accounts-mcp.example.com";
const next = "/accounts";
export const previews: Readonly<Record<string, Page>> = {
  "sign-in": { _tag: "SignIn", host, next },
  "sign-in-failed": { _tag: "SignIn", host, next, problem: "failed" },
  "sign-in-google-down": { _tag: "SignIn", host, next, problem: "google-down" },
  "not-owner": { _tag: "NotOwner", host, next, address: "someone.else@example.com" },
  mismatch: { _tag: "Mismatch" },
  "setup-incomplete": { _tag: "SetupIncomplete", names: ["GOOGLE_CLIENT_SECRET"] },
  "setup-incomplete-two": { _tag: "SetupIncomplete", names: ["OWNER_EMAIL", "GOOGLE_CLIENT_ID"] },
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

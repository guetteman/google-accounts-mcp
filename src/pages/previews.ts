import { GMAIL_SCOPES } from "../google/client";
import { acceptAuthorize } from "../oauth/clients";
import type { ConnectionView } from "../connections/model";
import type { Page } from "./page";

const connections: ReadonlyArray<ConnectionView> = [
  {
    id: "11111111-1111-4111-8111-111111111111" as ConnectionView["id"],
    name: "Work laptop",
    appLabel: "Claude Code",
    status: { kind: "active" },
    lastUsed: "Nov 9",
    created: "Nov 1",
  },
  {
    id: "22222222-2222-4222-8222-222222222222" as ConnectionView["id"],
    name: "Claude",
    appLabel: "Claude",
    status: { kind: "active" },
    lastUsed: "Nov 8",
    created: "Nov 1",
  },
  {
    id: "33333333-3333-4333-8333-333333333333" as ConnectionView["id"],
    name: "ChatGPT",
    appLabel: "ChatGPT",
    status: { kind: "active" },
    lastUsed: "Never",
    created: "Nov 1",
  },
  {
    id: "44444444-4444-4444-8444-444444444444" as ConnectionView["id"],
    name: "Old laptop",
    appLabel: "Claude Code",
    status: { kind: "expired", on: "Nov 6" },
    lastUsed: "Aug 8",
    created: "Aug 8",
  },
  {
    id: "55555555-5555-4555-8555-555555555555" as ConnectionView["id"],
    name: "Personal laptop",
    appLabel: "Claude Code",
    status: { kind: "revoked", on: "Sep 14" },
    lastUsed: "Sep 14",
    created: "Sep 1",
  },
];
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
    accounts: [
      {
        id: "11111111-1111-4111-8111-111111111111" as import("../accounts/model").AccountId,
        name: "Personal",
        email: "alex.personal@example.com",
        workspace: false,
        status: { kind: "ready" },
      },
      {
        id: "22222222-2222-4222-8222-222222222222" as import("../accounts/model").AccountId,
        name: "Side projects",
        email: "alex.projects@example.com",
        workspace: false,
        status: { kind: "needs_reconnect" },
      },
      {
        id: "33333333-3333-4333-8333-333333333333" as import("../accounts/model").AccountId,
        name: "Work",
        email: "alex@harbor.example",
        workspace: true,
        status: { kind: "blocked_by_admin" },
      },
      {
        id: "44444444-4444-4444-8444-444444444444" as import("../accounts/model").AccountId,
        name: "Research and operations shared inbox",
        email: "research@harbor.example",
        workspace: true,
        status: { kind: "missing_access", granted: 2 },
      },
      {
        id: "55555555-5555-4555-8555-555555555555" as import("../accounts/model").AccountId,
        name: "Recovery",
        email: "recovery@example.com",
        workspace: false,
        status: { kind: "unreadable" },
      },
    ],
    alert: { kind: "reconnected", address: "alex.personal@example.com" },
    _tag: "Accounts",
    requiredGmailScopes: GMAIL_SCOPES.length,
    frame: { host, ownerEmail: "owner@example.com", current: "accounts" },
  },
  "accounts-empty": {
    _tag: "Accounts",
    requiredGmailScopes: GMAIL_SCOPES.length,
    frame: { host, ownerEmail: "owner@example.com", current: "accounts" },
    accounts: [],
    alert: null,
  },
  "client-refused": { _tag: "ClientRefused" },
  "consent-expired": { _tag: "ConsentExpired" },
  ...Object.fromEntries(
    [
      [
        "claude-code",
        "https://claude.ai/oauth/claude-code-client-metadata",
        "http://localhost:3118/callback",
      ],
      [
        "claude",
        "https://claude.ai/oauth/mcp-oauth-client-metadata",
        "https://claude.ai/api/mcp/auth_callback",
      ],
      [
        "chatgpt",
        "https://chatgpt.com/oauth/client.json",
        "https://chatgpt.com/connector_platform_oauth_redirect",
      ],
    ].map(([id, clientId, callback]) => [
      `consent-${id}`,
      {
        _tag: "Consent" as const,
        host,
        ownerEmail: "owner@example.com",
        client: acceptAuthorize(clientId!, callback!)!,
        handle: "preview",
        generation: 1,
      },
    ]),
  ),
  "connections-empty": {
    _tag: "Connections",
    frame: { host, ownerEmail: "owner@example.com", current: "connections" },
    connections: [],
    mcpUrl: `https://${host}/mcp`,
  },
  connections: {
    _tag: "Connections",
    connections,
    mcpUrl: `https://${host}/mcp`,
    frame: { host, ownerEmail: "owner@example.com", current: "connections" },
  },
};

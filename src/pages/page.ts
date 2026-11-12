import type { ApprovalPageProps } from "../approvals/model";
import type { AcceptedClient } from "../oauth/clients";
import type { ConnectionView } from "../connections/model";
import type { ConfigName } from "../config";
import type { Group } from "../mcp/groups";

import type { AccountView } from "../accounts/model";
import type { AccountsAlert } from "../accounts/flow";

export const PRODUCT = "Google Accounts MCP";
export interface Frame {
  readonly host: string;
  readonly ownerEmail: string;
  readonly current: "accounts" | "connections";
}
export type FramePage =
  | {
      readonly _tag: "Connection";
      readonly permissionNotice?: string;
      readonly frame: Frame;
      readonly connection: ConnectionView;
      readonly accounts: ReadonlyArray<AccountView>;
      readonly tools: ReadonlyArray<{
        name: string;
        label: string;
        description: string;
        group: Group;
      }>;
      readonly settings: Readonly<Record<string, "ask" | "allow">>;
      readonly requiredGmailScopes: number;
    }
  | {
      readonly _tag: "Accounts";
      readonly requiredGmailScopes: number;
      readonly frame: Frame;
      readonly accounts: ReadonlyArray<AccountView>;
      readonly alert: AccountsAlert | null;
    }
  | {
      readonly _tag: "Connections";
      readonly frame: Frame;
      readonly connections: ReadonlyArray<ConnectionView>;
      readonly mcpUrl: string;
    };
export type Page =
  | {
      readonly _tag: "Consent";
      readonly host: string;
      readonly ownerEmail: string;
      readonly client: AcceptedClient;
      readonly handle: string;
      readonly generation: number;
    }
  | { readonly _tag: "ClientRefused" }
  | { readonly _tag: "ConsentExpired" }
  | { readonly _tag: "AccessRefused"; readonly host: string }
  | { readonly _tag: "AccessUnavailable" }
  | { readonly _tag: "NotOwner"; readonly host: string; readonly address: string }
  | { readonly _tag: "Mismatch" }
  | { readonly _tag: "SetupIncomplete"; readonly names: ConfigName[] }
  | { readonly _tag: "Unavailable" }
  | FramePage
  | ApprovalPageProps;

export const isFramePage = (page: Page): page is FramePage =>
  page._tag === "Accounts" || page._tag === "Connections" || page._tag === "Connection";

export type HydratedPage = FramePage | ApprovalPageProps;
export const isHydratedPage = (page: Page): page is HydratedPage =>
  isFramePage(page) || page._tag === "Approval";

import type { AcceptedClient } from "../oauth/clients";
import type { ConnectionView } from "../connections/model";
import type { ConfigName } from "../config";

export const PRODUCT = "Google Accounts MCP";
export interface Frame {
  readonly host: string;
  readonly ownerEmail: string;
  readonly current: "accounts" | "connections";
}
export type FramePage =
  | { readonly _tag: "Accounts"; readonly frame: Frame }
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
  | FramePage;

export const isFramePage = (page: Page): page is FramePage =>
  page._tag === "Accounts" || page._tag === "Connections";

import type { ConfigName } from "../config";

export const PRODUCT = "Google Accounts MCP";
export interface Frame {
  readonly host: string;
  readonly ownerEmail: string;
  readonly current: "accounts" | "connections";
}
export type FramePage = { readonly _tag: "Accounts" | "Connections"; readonly frame: Frame };
export type Page =
  | { readonly _tag: "AccessRefused"; readonly host: string }
  | { readonly _tag: "AccessUnavailable" }
  | { readonly _tag: "NotOwner"; readonly host: string; readonly address: string }
  | { readonly _tag: "Mismatch" }
  | { readonly _tag: "SetupIncomplete"; readonly names: ConfigName[] }
  | { readonly _tag: "Unavailable" }
  | FramePage;

export const isFramePage = (page: Page): page is FramePage =>
  page._tag === "Accounts" || page._tag === "Connections";

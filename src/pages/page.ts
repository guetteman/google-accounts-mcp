import type { ConfigName } from "../config";

export const PRODUCT = "Google Accounts MCP";
export type SignInProblem = "failed" | "google-down";
export interface Frame {
  readonly host: string;
  readonly ownerEmail: string;
  readonly current: "accounts" | "connections";
}
export type FramePage = { readonly _tag: "Accounts" | "Connections"; readonly frame: Frame };
export type Page =
  | {
      readonly _tag: "SignIn";
      readonly host: string;
      readonly next: string;
      readonly problem?: SignInProblem;
    }
  | {
      readonly _tag: "NotOwner";
      readonly host: string;
      readonly address?: string;
      readonly next: string;
    }
  | { readonly _tag: "Mismatch" }
  | { readonly _tag: "SetupIncomplete"; readonly names: ConfigName[] }
  | { readonly _tag: "Unavailable" }
  | FramePage;

export const isFramePage = (page: Page): page is FramePage =>
  page._tag === "Accounts" || page._tag === "Connections";

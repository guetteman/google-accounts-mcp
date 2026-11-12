import type { AccountId } from "../accounts/model";
import type { ConnectionId, App } from "../connections/model";
import type { WonBrand } from "./store";
import type { AccountTool } from "../mcp/tools";
import type { Sealed } from "../seal";

export type ApprovalId = string & { readonly __approvalId: unique symbol };
export const parseApprovalId = (value: unknown): ApprovalId | null =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
    ? (value as ApprovalId)
    : null;
export const APPROVAL_LIFETIME = 3_600_000;
export const RESULT_LIFETIME = 3_600_000;
export const RUN_DEADLINE = 25_000;
export const OUTCOME_WINDOW = 30_000;
export const WAITING_LIMIT = 20;
export interface Use {
  account: AccountId;
  tool: AccountTool;
}
export interface ApprovalAccount {
  id: AccountId;
  name: string;
  email: string;
  hd: string | null;
}
interface Common {
  id: ApprovalId;
  connection: { id: ConnectionId; name: string; app: App };
  accounts: readonly ApprovalAccount[];
  uses: readonly Use[];
  tool: AccountTool;
  call: number;
  createdAt: number;
  expiresAt: number;
}
export type Approval = Common &
  (
    | { state: "waiting"; arguments: Sealed }
    | { state: "running"; decidedAt: number }
    | {
        state: "finished";
        decidedAt: number;
        outcome: "success" | "failed" | "unknown";
        result: Sealed | null;
      }
    | { state: "rejected"; decidedAt: number }
    | { state: "expired" }
    | { state: "refused"; endedBy: "tool" | "connection" | "account" }
  );
export type Won = {
  readonly id: ApprovalId;
  readonly at: number;
  readonly claim: string;
} & WonBrand;
export type Target =
  | { connection: ConnectionId }
  | { account: AccountId }
  | { connection: ConnectionId; account: AccountId; tool: AccountTool };
export interface ApprovalRequest {
  connection: { id: string; name: string; app: string };
  account: { name: string; email: string; workspace: boolean };
  tool: { label: string; action: string; joiner: string; empty: string };
  notes: ReadonlyArray<ViewNote>;
  values: ReadonlyArray<ViewValue>;
}
/**
 * A sentence of the page's own about a call. The page never shades it, so it must never hold
 * text that someone else chose: a tool computes its notes from the arguments alone, before any
 * read of Gmail, and writes the words itself. Text of the agent or of a mail goes in a ViewValue.
 */
export interface ViewNote {
  text: string;
  warning: boolean;
}
/** One value of a view. Its text is the agent's own, or was read from the account's mail. */
export interface ViewValue {
  name: string;
  text: string;
  from: "agent" | "gmail";
}
export type ApprovalState =
  | { kind: "waiting"; shown: boolean; changed: boolean; digest: string | null }
  | { kind: "running" }
  | { kind: "succeeded" }
  | { kind: "failed"; message: string | null }
  | { kind: "unknown" }
  | { kind: "rejected" }
  | { kind: "expired" }
  | { kind: "ended"; by: "tool" | "connection" | "account" };
export interface ApprovalPageProps {
  _tag: "Approval";
  id: string;
  request: ApprovalRequest;
  times: {
    asked: string;
    askedOn: string;
    expires: string;
    expiresOn: string;
    minutesSinceAsked: number;
    minutesLeft: number;
    decidedOn: string | null;
  };
  state: ApprovalState;
  unconfirmed?: boolean;
}
export type StoredPayload = { result: unknown } | { error: { code: string; message: string } };
export const isoSeconds = (time: number) => new Date(time).toISOString().replace(/\.\d{3}Z$/, "Z");
/** A time as a view shows it, with its year: `Nov 12, 2026 at 10:02 UTC`. */
export const viewDate = (at: number): string => {
  const date = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(at);
  const time = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(at);
  return `${date} at ${time} UTC`;
};

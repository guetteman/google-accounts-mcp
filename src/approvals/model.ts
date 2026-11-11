import type { AccountId } from "../accounts/model";
import type { ConnectionId, App } from "../connections/model";
import type { Generation } from "../owner/owner";
import type { AccountTool } from "../mcp/tools";
import type { Sealed } from "../seal";

export type ApprovalId = string & { readonly __approvalId: unique symbol };
export const parseApprovalId = (value: unknown): ApprovalId | null =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
    ? (value as ApprovalId)
    : null;
export const HOUR = 3_600_000;
export interface Use {
  account: AccountId;
  tool: AccountTool;
}
export interface SnapshotAccount {
  id: AccountId;
  name: string;
  email: string;
  hd: string | null;
  version: number;
}
export interface ApprovalRow {
  id: ApprovalId;
  generation: Generation;
  connection_id: ConnectionId;
  call_id: number;
  tool: AccountTool;
  uses: string;
  created_at: number;
  expires_at: number;
  state: "waiting" | "approved" | "rejected" | "expired" | "refused";
  ended_by: "tool" | "connection" | "account" | null;
  decided_at: number | null;
  outcome: "success" | "failed" | "unknown" | null;
  arguments: Sealed | null;
  result: Sealed | null;
  result_too_large: number;
  purged: number;
  connection_name: string;
  app: App;
  accounts: string;
}
export interface ApprovalRequest {
  connection: { id: string; name: string; app: string };
  account: { name: string; email: string; workspace: boolean };
  tool: { label: string; action: string; joiner: string; empty: string };
  values: ReadonlyArray<{ name: string; text: string }>;
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

import { Effect, Schema } from "effect";
import { APP_LABELS } from "../connections/model";
import { open } from "../seal";
import type { TokenKey } from "../config";
import { TOOLS } from "../mcp/tools";
import type {
  ApprovalPageProps,
  ApprovalRequest,
  ApprovalRow,
  SnapshotAccount,
  StoredPayload,
} from "./model";

// Property order is explicit, including each value in the order the owner reads it.
export const viewDigest = async (request: ApprovalRequest) => {
  const canonical = JSON.stringify({
    connection: {
      id: request.connection.id,
      name: request.connection.name,
      app: request.connection.app,
    },
    account: {
      name: request.account.name,
      email: request.account.email,
      workspace: request.account.workspace,
    },
    tool: {
      label: request.tool.label,
      action: request.tool.action,
      joiner: request.tool.joiner,
      empty: request.tool.empty,
    },
    values: request.values.map(({ name, text }) => ({ name, text })),
  });
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical))),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
};
export async function storedPayload(
  row: ApprovalRow,
  key: TokenKey,
): Promise<StoredPayload | null> {
  if (!row.result) return null;
  const payload = await open(key, `${row.id}:result`, row.result);
  if (!payload.ok) return null;
  const parsed: unknown = JSON.parse(payload.value);
  if (typeof parsed !== "object" || parsed === null) return null;
  if ("result" in parsed) return { result: parsed.result };
  if (
    "error" in parsed &&
    typeof parsed.error === "object" &&
    parsed.error !== null &&
    "code" in parsed.error &&
    typeof parsed.error.code === "string" &&
    "message" in parsed.error &&
    typeof parsed.error.message === "string"
  )
    return { error: { code: parsed.error.code, message: parsed.error.message } };
  return null;
}
const clock = (at: number) =>
  `${new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" }).format(at)} UTC`;
const dated = (at: number) =>
  `${new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(at)} at ${clock(at)}`;
export async function approvalView(row: ApprovalRow, key: TokenKey, now: number, changed = false) {
  const tool = TOOLS.find((t) => t.kind === "account" && t.name === row.tool);
  if (!tool || tool.kind !== "account") throw new Error("Unknown approval tool");
  const accounts = JSON.parse(row.accounts) as SnapshotAccount[];
  const account = accounts[0];
  if (!account) throw new Error("Missing approval account");
  const request: ApprovalRequest = {
    connection: { id: row.connection_id, name: row.connection_name, app: APP_LABELS[row.app] },
    account: { name: account.name, email: account.email, workspace: account.hd !== null },
    tool: {
      label: tool.label,
      action: tool.view.action,
      joiner: tool.view.joiner,
      empty: tool.view.empty,
    },
    values: [],
  };
  let decoded: { readonly account: string } | null = null;
  let digest: string | null = null;
  if (row.state === "waiting" && row.arguments) {
    try {
      const opened = await open(key, `${row.id}:arguments`, row.arguments);
      if (opened.ok) {
        const parsed = Schema.decodeUnknownOption(tool.input)(JSON.parse(opened.value));
        if (parsed._tag === "Some") {
          const values = await Effect.runPromise(tool.view.values(parsed.value));
          request.values = values;
          digest = await viewDigest(request);
          decoded = parsed.value;
        }
      }
    } catch {
      /* A view that cannot be built must never offer Approve. */
    }
  }
  const payload = row.outcome === "failed" ? await storedPayload(row, key) : null;
  const state: ApprovalPageProps["state"] =
    row.state === "waiting"
      ? { kind: "waiting", shown: decoded !== null, changed, digest }
      : row.state === "approved"
        ? row.outcome === null
          ? { kind: "running" }
          : row.outcome === "success"
            ? { kind: "succeeded" }
            : row.outcome === "unknown"
              ? { kind: "unknown" }
              : {
                  kind: "failed",
                  message: payload && "error" in payload ? payload.error.message : null,
                }
        : row.state === "refused"
          ? { kind: "ended", by: row.ended_by! }
          : { kind: row.state };
  const page: ApprovalPageProps = {
    _tag: "Approval",
    id: row.id,
    request,
    state,
    times: {
      asked: clock(row.created_at),
      askedOn: dated(row.created_at),
      expires: clock(row.expires_at),
      expiresOn: dated(row.expires_at),
      minutesSinceAsked: Math.max(0, Math.floor((now - row.created_at) / 60000)),
      minutesLeft: Math.max(0, Math.ceil((row.expires_at - now) / 60000)),
      decidedOn: row.decided_at === null ? null : dated(row.decided_at),
    },
  };
  return { page, tool, decoded, snapshot: { connection: row.connection_name, accounts } };
}

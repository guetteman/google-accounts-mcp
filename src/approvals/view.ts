import { ToolFailure } from "../mcp/failures";
import { Effect } from "effect";
import { APP_LABELS } from "../connections/model";
import { openArguments } from "./text";
import type { TokenKey } from "../config";
import { decodeArgs, TOOLS, type DecodedArgs, type Send } from "../mcp/tools";
import type { Approval, ApprovalPageProps, ApprovalRequest } from "./model";

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
    notes: request.notes.map(({ text, warning }) => ({ text, warning })),
    values: request.values.map(({ name, text, from }) => ({ name, text, from })),
  });
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical))),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
};
const clock = (at: number) =>
  `${new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" }).format(at)} UTC`;
const dated = (at: number) =>
  `${new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(at)} at ${clock(at)}`;
export async function approvalView(
  row: Approval,
  key: TokenKey,
  now: number,
  changed = false,
  outcomeMessage: string | null = null,
  send?: Send,
) {
  const tool = TOOLS.find((t) => t.kind === "account" && t.name === row.tool);
  if (!tool || tool.kind !== "account") throw new Error("Unknown approval tool");
  const account = row.accounts[0];
  if (!account) throw new Error("Missing approval account");
  const request: ApprovalRequest = {
    connection: {
      id: row.connection.id,
      name: row.connection.name,
      app: APP_LABELS[row.connection.app],
    },
    account: { name: account.name, email: account.email, workspace: account.hd !== null },
    tool: {
      label: tool.label,
      action: tool.view.action,
      joiner: tool.view.joiner,
      empty: tool.view.empty,
    },
    notes: [],
    values: [],
  };
  let decoded: DecodedArgs | null = null;
  let digest: string | null = null;
  if (row.state === "waiting" && row.uses.length === 1) {
    try {
      const opened = await openArguments(key, row.id, row.arguments);
      if (opened !== null) {
        const parsed = decodeArgs(tool, opened);
        if (parsed.ok) {
          const notes = tool.view.notes?.(parsed.value) ?? [];
          const values = await Effect.runPromise(
            tool.view.values(
              parsed.value,
              send ?? (() => Effect.fail(new ToolFailure({ code: "google_unavailable" }))),
            ),
          );
          digest = await viewDigest({ ...request, notes, values });
          request.notes = notes;
          request.values = values;
          decoded = parsed.value;
        }
      }
    } catch {
      /* A view that cannot be built must never offer Approve. */
    }
  }
  let state: ApprovalPageProps["state"];
  switch (row.state) {
    case "waiting":
      state = { kind: "waiting", shown: decoded !== null, changed, digest };
      break;
    case "running":
      state = { kind: "running" };
      break;
    case "finished":
      state =
        row.outcome === "failed"
          ? { kind: "failed", message: outcomeMessage }
          : row.outcome === "unknown"
            ? { kind: "unknown", ...(outcomeMessage !== null ? { message: outcomeMessage } : {}) }
            : { kind: "succeeded" };
      break;
    case "refused":
      state = { kind: "ended", by: row.endedBy };
      break;
    case "expired":
    case "rejected":
      state = { kind: row.state };
  }
  const page: ApprovalPageProps = {
    _tag: "Approval",
    id: row.id,
    request,
    state,
    times: {
      asked: clock(row.createdAt),
      askedOn: dated(row.createdAt),
      expires: clock(row.expiresAt),
      expiresOn: dated(row.expiresAt),
      minutesSinceAsked: Math.max(0, Math.floor((now - row.createdAt) / 60000)),
      minutesLeft: Math.max(0, Math.ceil((row.expiresAt - now) / 60000)),
      decidedOn: "decidedAt" in row ? dated(row.decidedAt) : null,
    },
  };
  return { page, tool, decoded };
}

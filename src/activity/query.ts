import { parseAccountId } from "../accounts/model";
import type { CallId } from "../calls/store";
import { parseConnectionId } from "../connections/model";
import type { ActivityQuery } from "./store";

export const OUTCOME_WORDS = [
  "pending",
  "refused",
  "failed",
  "rejected",
  "expired",
  "unknown",
  "repeat",
  "success",
] as const;

/** Only checked IDs, outcomes, and positions enter the store. */
export function parseActivityQuery(params: URLSearchParams): ActivityQuery {
  const connection = parseConnectionId(params.get("connection"));
  const account = parseAccountId(params.get("account"));
  const outcome = OUTCOME_WORDS.find((word) => word === params.get("outcome"));
  const raw = params.get("before");
  const before = raw && /^\d+$/.test(raw) ? Number(raw) : NaN;
  return {
    filter: connection
      ? { kind: "connection", id: connection }
      : account
        ? { kind: "account", id: account }
        : outcome
          ? { kind: "outcome", outcome }
          : null,
    before: Number.isSafeInteger(before) && before > 0 ? (before as CallId) : null,
  };
}

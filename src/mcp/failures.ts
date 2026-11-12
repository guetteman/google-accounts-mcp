import { Data } from "effect";
import { accountMessage } from "../accounts/model";
import type { Outcome } from "../calls/store";
import { WAITING_LIMIT } from "../approvals/model";
import type { ConnectionId } from "../connections/model";
export const failures = {
  approval_not_available: {
    outcome: "refused",
    message: () => "This approval is not available to this connection.",
  },
  approval_limit_reached: {
    outcome: "refused",
    message: () =>
      `This connection already has ${WAITING_LIMIT} calls waiting for approval. Wait for the owner to decide or for an approval to expire.`,
  },
  not_found: { outcome: "refused", message: () => "The requested item does not exist." },
  invalid_arguments: { outcome: "refused", message: () => "The arguments are not valid." },
  account_not_available: {
    outcome: "refused",
    message: (input: string) =>
      `No account "${input}" is available to this connection. Call list_accounts to see the accounts you can use.`,
  },
  account_needs_reconnect: {
    outcome: "failed",
    message: (_: string, email: string, origin: string) =>
      accountMessage("needs_reconnect", email, origin),
  },
  account_blocked_by_admin: {
    outcome: "failed",
    message: (_: string, email: string, origin: string) =>
      accountMessage("blocked_by_admin", email, origin),
  },
  account_missing_access: {
    outcome: "failed",
    message: (_: string, email: string, origin: string) =>
      accountMessage("missing_access", email, origin),
  },
  account_unreadable: {
    outcome: "failed",
    message: (_: string, email: string, origin: string) =>
      accountMessage("unreadable", email, origin),
  },
  google_unavailable: {
    outcome: "failed",
    message: (_: string, email: string) =>
      `Google could not complete the request for ${email}. Try again later.`,
  },
  server_unavailable: {
    outcome: "failed",
    message: () => "The server could not complete the call. Try again later.",
  },
  tool_not_allowed: {
    outcome: "refused",
    message: (_: string, email: string, origin: string, tool: string, connection: ConnectionId) =>
      `The owner has not allowed ${tool} on ${email} for this connection. The owner can change this at ${origin}/connections/${connection}.`,
  },
} satisfies Record<
  string,
  {
    outcome: Outcome;
    message: (
      input: string,
      email: string,
      origin: string,
      tool: string,
      connection: ConnectionId,
    ) => string;
  }
>;
export type Missing = "thread" | "message" | "draft" | "attachment" | "label";
export const notFound = (kind: Missing, id: string): ToolFailure =>
  new ToolFailure({ code: "not_found", missing: { kind, id } });
export class ToolFailure extends Data.TaggedError("ToolFailure")<{
  code: keyof typeof failures;
  unknown?: boolean;
  missing?: { kind: Missing; id: string };
  reason?: "arguments_too_large";
  /** The field that is wrong, with what it must be. */
  field?: { name: string; expects: string };
}> {}

export function classify(
  error: unknown,
  when: { approved: boolean; aborted: boolean },
  text: { input: string; email: string; origin: string; tool: string; connection: ConnectionId },
): { audit: Outcome | null; error: { code: keyof typeof failures; message: string } | null } {
  const failure =
    error instanceof ToolFailure ? error : new ToolFailure({ code: "server_unavailable" });
  const entry = failures[failure.code];
  const unknown =
    failure.unknown || when.aborted || (when.approved && failure.code === "server_unavailable");
  return {
    audit: unknown ? null : entry.outcome,
    error:
      when.approved && unknown
        ? null
        : {
            code: failure.code,
            message:
              failure.reason === "arguments_too_large"
                ? "The arguments are too large. The limit is 256 KB."
                : failure.field
                  ? `The ${failure.field.name} field must be ${failure.field.expects}.`
                  : failure.missing
                    ? `No ${failure.missing.kind} "${failure.missing.id}" exists in ${text.email}. A ${failure.missing.kind} ID works only in the account that returned it.`
                    : entry.message(
                        text.input,
                        text.email,
                        text.origin,
                        text.tool,
                        text.connection,
                      ),
          },
  };
}

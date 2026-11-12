import { Data, Effect } from "effect";
import { accountMessage } from "../accounts/model";
import type { Outcome } from "../calls/store";
import { WAITING_LIMIT } from "../approvals/model";
import type { ConnectionId } from "../connections/model";
import type { ToolAnnotations } from "./tools";
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
  message_too_large: {
    outcome: "refused",
    message: () => "Gmail refused this message as too large.",
  },
  message_not_sendable: { outcome: "refused", message: () => "Gmail refused this message." },
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
  outcome_unknown: {
    outcome: "repeat",
    message: () => "The server does not know whether the call completed.",
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
export const notFound = (kind: Missing, id: string | readonly string[]): ToolFailure =>
  new ToolFailure({ code: "not_found", missing: { kind, id } });
export const messageTooLarge = (
  over: { bytes: number } | { attachments: number } | null,
): ToolFailure => new ToolFailure({ code: "message_too_large", over });
export const notSendable = (draft: string | null): ToolFailure =>
  new ToolFailure({ code: "message_not_sendable", unsendable: { draft } });
export class ToolFailure extends Data.TaggedError("ToolFailure")<{
  code: keyof typeof failures;
  unknown?: boolean;
  released?: true;
  over?: { bytes: number } | { attachments: number } | null;
  unsendable?: { draft: string | null };
  said?: string;
  missing?: { kind: Missing; id: string | readonly string[] };
  reason?: "arguments_too_large";
  /** The field that is wrong, with what it must be. */
  field?: { name: string; expects: string };
}> {}

const missingMessage = ({ kind, id }: NonNullable<ToolFailure["missing"]>, email: string) => {
  const ids = typeof id === "string" ? [id] : id;
  const subject =
    ids.length === 1
      ? `No ${kind} "${ids[0]}"`
      : `None of the ${kind}s ${ids.map((id) => `"${id}"`).join(", ")}`;
  return `${subject} exists in ${email}. A ${kind} ID works only in the account that returned it.`;
};
/** Mark only the request that creates or sends, never a preparing read or write. */
export const creating = <A>(
  request: Effect.Effect<A, ToolFailure>,
): Effect.Effect<A, ToolFailure> =>
  request.pipe(
    Effect.mapError((failure) =>
      failure.unknown ? new ToolFailure({ code: "outcome_unknown", unknown: true }) : failure,
    ),
  );

export function classify(
  error: unknown,
  when: { approved: boolean; aborted: boolean },
  text: {
    input: string;
    email: string;
    origin: string;
    tool: string;
    connection: ConnectionId;
    annotations?: ToolAnnotations;
  },
): { audit: Outcome | null; error: { code: keyof typeof failures; message: string } | null } {
  const failure =
    error instanceof ToolFailure ? error : new ToolFailure({ code: "server_unavailable" });
  const entry = failures[failure.code];
  const unknown =
    !failure.released &&
    (failure.unknown || when.aborted || (when.approved && failure.code === "server_unavailable"));
  const message =
    failure.code === "google_unavailable" &&
    failure.unknown &&
    text.annotations?.readOnlyHint === false
      ? `Google did not confirm the request for ${text.email}. It may have taken effect.${text.annotations.idempotentHint ? " Sending the same call again is safe." : ""}`
      : entry.message(text.input, text.email, text.origin, text.tool, text.connection);
  return {
    audit: unknown ? null : entry.outcome,
    error:
      when.approved && unknown
        ? null
        : {
            code: failure.code,
            message:
              failure.said ??
              (failure.reason === "arguments_too_large"
                ? "The arguments are too large. The limit is 256 KB."
                : failure.field
                  ? `The ${failure.field.name} field must be ${failure.field.expects}.`
                  : failure.missing
                    ? missingMessage(failure.missing, text.email)
                    : failure.over
                      ? "bytes" in failure.over
                        ? `This forward would have ${failure.over.bytes.toLocaleString("en-US")} bytes of attachments and text. The limit is 25,000,000 bytes.`
                        : `This forward would have ${failure.over.attachments} attachments. The limit is 30.`
                      : failure.unsendable
                        ? failure.unsendable.draft === null
                          ? `Gmail refused this message from ${text.email}. Check that every address is valid.`
                          : `Gmail refused to send draft "${failure.unsendable.draft}" from ${text.email}. A draft needs at least one recipient, and every address must be valid. The owner can complete it in Gmail.`
                        : message),
          },
  };
}

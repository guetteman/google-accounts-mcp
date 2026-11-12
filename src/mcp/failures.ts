import { Data, Effect } from "effect";
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
  attachment_too_large: { outcome: "refused", message: () => "The attachment is too large." },
  attachment_not_readable: {
    outcome: "refused",
    message: () => "This client cannot read the attachment.",
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
export const notFound = (kind: Missing, id: string): ToolFailure =>
  new ToolFailure({ code: "not_found", missing: { kind, id } });
type FileInfo = { filename: string; type: string; size: number };
export const tooLarge = (file: FileInfo, limit: number): ToolFailure =>
  new ToolFailure({
    code: "attachment_too_large",
    file: { filename: file.filename, type: file.type, size: file.size },
    limit,
  });
export const notReadable = (file: FileInfo): ToolFailure =>
  new ToolFailure({
    code: "attachment_not_readable",
    file: { filename: file.filename, type: file.type, size: file.size },
  });
type FailureData = {
  unknown?: boolean;
  said?: string;
  missing?: { kind: Missing; id: string };
  reason?: "arguments_too_large";
  /** The field that is wrong, with what it must be. */
  field?: { name: string; expects: string };
} & (
  | { code: "attachment_too_large"; file: FileInfo; limit: number }
  | { code: "attachment_not_readable"; file: FileInfo; limit?: never }
  | {
      code: Exclude<keyof typeof failures, "attachment_too_large" | "attachment_not_readable">;
      file?: never;
      limit?: never;
    }
);
export const ToolFailure = Data.TaggedError("ToolFailure")<FailureData>;
export type ToolFailure = InstanceType<typeof ToolFailure>;

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
  text: { input: string; email: string; origin: string; tool: string; connection: ConnectionId },
): { audit: Outcome | null; error: { code: keyof typeof failures; message: string } | null } {
  const failure =
    error instanceof ToolFailure ? error : new ToolFailure({ code: "server_unavailable" });
  const entry = failures[failure.code];
  const unknown =
    failure.unknown || when.aborted || (when.approved && failure.code === "server_unavailable");
  const filename = failure.file?.filename ? JSON.stringify(failure.file.filename) : "(no name)";
  const fileMessage =
    failure.file &&
    (failure.code === "attachment_too_large"
      ? `The attachment ${filename} has ${failure.file.size.toLocaleString("en-US")} bytes. The limit is ${failure.limit.toLocaleString("en-US")} bytes.`
      : failure.code === "attachment_not_readable"
        ? `This client cannot read ${filename} (type ${JSON.stringify(failure.file.type)}). The owner can open it with Claude Code.`
        : null);
  return {
    audit: unknown ? null : entry.outcome,
    error:
      when.approved && unknown
        ? null
        : {
            code: failure.code,
            message:
              failure.said ??
              fileMessage ??
              (failure.reason === "arguments_too_large"
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
                      )),
          },
  };
}

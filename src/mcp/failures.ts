import { Data, Effect } from "effect";
import { accountMessage } from "../accounts/model";
import type { Outcome } from "../calls/store";
import { WAITING_LIMIT } from "../approvals/model";
import type { ConnectionId } from "../connections/model";
import type { ToolAnnotations } from "./tools";
export const failures = {
  upload_not_available: {
    outcome: "refused",
    label: "Upload not available",
    message: (id: string) =>
      `No upload "${id}" is available to this connection. An upload works once, in the connection that asked for its link, before it expires. Call create_upload_link and send the file again.`,
  },
  upload_not_ready: {
    outcome: "failed",
    label: "Uploaded file not ready",
    message: () =>
      "The server cannot read the uploaded file yet. Call again with the same arguments in one minute.",
  },
  approval_not_available: {
    outcome: "refused",
    label: "Approval not available to this connection",
    message: () => "This approval is not available to this connection.",
  },
  approval_limit_reached: {
    outcome: "refused",
    label: "Too many calls waiting for approval",
    message: () =>
      `This connection already has ${WAITING_LIMIT} calls waiting for approval. Wait for the owner to decide or for an approval to expire.`,
  },
  attachment_too_large: {
    outcome: "refused",
    label: "Attachment too large",
    message: () => "The attachment is too large.",
  },
  attachment_not_readable: {
    outcome: "refused",
    label: "Attachment not readable by this client",
    message: () => "This client cannot read the attachment.",
  },
  not_found: {
    outcome: "refused",
    label: "Item not found in the account",
    message: () => "The requested item does not exist.",
  },
  message_too_large: {
    outcome: "refused",
    label: "Message too large",
    message: () => "Gmail refused this message as too large.",
  },
  message_not_sendable: {
    outcome: "refused",
    label: "Gmail refused the message",
    message: () => "Gmail refused this message.",
  },
  invalid_arguments: {
    outcome: "refused",
    label: "Input not valid",
    message: () => "The arguments are not valid.",
  },
  account_not_available: {
    outcome: "refused",
    label: "Account not available to this connection",
    message: (input: string) =>
      `No account "${input}" is available to this connection. Call list_accounts to see the accounts you can use.`,
  },
  account_needs_reconnect: {
    outcome: "failed",
    label: "Account needs reconnect",
    message: (_: string, email: string, origin: string) =>
      accountMessage("needs_reconnect", email, origin),
  },
  account_blocked_by_admin: {
    outcome: "failed",
    label: "Account blocked by admin",
    message: (_: string, email: string, origin: string) =>
      accountMessage("blocked_by_admin", email, origin),
  },
  account_missing_access: {
    outcome: "failed",
    label: "Account missing access",
    message: (_: string, email: string, origin: string) =>
      accountMessage("missing_access", email, origin),
  },
  account_unreadable: {
    outcome: "failed",
    label: "Can't read the account's stored access",
    message: (_: string, email: string, origin: string) =>
      accountMessage("unreadable", email, origin),
  },
  google_unavailable: {
    outcome: "failed",
    label: "Google did not complete the request",
    message: (_: string, email: string) =>
      `Google could not complete the request for ${email}. Try again later.`,
  },
  outcome_unknown: {
    outcome: "repeat",
    label: "Outcome unknown",
    message: () => "The server does not know whether the call completed.",
  },
  server_unavailable: {
    outcome: "failed",
    label: "The server could not complete the call",
    message: () => "The server could not complete the call. Try again later.",
  },
  tool_not_allowed: {
    outcome: "refused",
    label: "Tool not allowed",
    message: (_: string, email: string, origin: string, tool: string, connection: ConnectionId) =>
      `The owner has not allowed ${tool} on ${email} for this connection. The owner can change this at ${origin}/connections/${connection}.`,
  },
} satisfies Record<
  string,
  {
    outcome: Outcome;
    label: string;
    message: (
      input: string,
      email: string,
      origin: string,
      tool: string,
      connection: ConnectionId,
    ) => string;
  }
>;
export type FailureCode = keyof typeof failures;
/** The owner's words for a stored reason. An unknown code shows as itself. */
export const reasonLabel = (code: string): string =>
  Object.hasOwn(failures, code) ? failures[code as FailureCode].label : code;

export type Missing = "thread" | "message" | "draft" | "attachment" | "label";
export const notFound = (kind: Missing, id: string | readonly string[]): ToolFailure =>
  new ToolFailure({ code: "not_found", missing: { kind, id } });
export const messageTooLarge = (
  over:
    | { bytes: number; limit: number }
    | { attachments: number; limit: number }
    | { text: true }
    | null,
): ToolFailure => new ToolFailure({ code: "message_too_large", over });
export const notSendable = (draft: string | null): ToolFailure =>
  new ToolFailure({ code: "message_not_sendable", unsendable: { draft } });
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
export const uploadNotAvailable = (id: string): ToolFailure =>
  new ToolFailure({ code: "upload_not_available", about: { input: id, email: "" } });
export const uploadNotReady = (): ToolFailure => new ToolFailure({ code: "upload_not_ready" });
type FailureData = {
  about?: { input: string; email: string; tool?: string };
  unknown?: boolean;
  /** The once row was released; do not classify this as an unknown call. */
  released?: true;
  /** Nothing was sent; a staged draft may remain, with its ID when known. */
  leftover?: { draft?: string };
  /** The exceeded local limit, unreadable original text, or null for Gmail's size refusal. */
  over?:
    | { bytes: number; limit: number }
    | { attachments: number; limit: number }
    | { text: true }
    | null;
  /** An existing draft the owner can complete, or null for composed mail. */
  unsendable?: { draft: string | null };
  said?: string;
  missing?: { kind: Missing; id: string | readonly string[] };
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
): {
  audit: Outcome | null;
  reason: FailureCode | null;
  error: { code: FailureCode; message: string } | null;
} {
  const failure =
    error instanceof ToolFailure ? error : new ToolFailure({ code: "server_unavailable" });
  text = { ...text, ...failure.about };
  const entry = failures[failure.code];
  const unknown =
    !failure.released &&
    (failure.unknown || when.aborted || (when.approved && failure.code === "server_unavailable"));
  const filename = failure.file?.filename ? JSON.stringify(failure.file.filename) : "(no name)";
  const fileMessage =
    failure.file &&
    (failure.code === "attachment_too_large"
      ? `The attachment ${filename} has ${failure.file.size.toLocaleString("en-US")} bytes. The limit is ${failure.limit.toLocaleString("en-US")} bytes.`
      : failure.code === "attachment_not_readable"
        ? `This client cannot read ${filename} (type ${JSON.stringify(failure.file.type)}). The owner can open it with Claude Code.`
        : null);
  const message =
    failure.code === "google_unavailable" &&
    failure.unknown &&
    text.annotations?.readOnlyHint === false
      ? `Google did not confirm the request for ${text.email}. It may have taken effect.${text.annotations.idempotentHint ? " Sending the same call again is safe." : ""}`
      : entry.message(text.input, text.email, text.origin, text.tool, text.connection);
  const describe = (message: string) => {
    if (!failure.leftover) return message;
    const draft =
      failure.leftover.draft === undefined
        ? "a draft of this mail"
        : `draft ${JSON.stringify(failure.leftover.draft)} of this mail`;
    const advice = `${draft} may be left in Drafts. The owner should delete it there before this call is made again.`;
    return failure.code === "google_unavailable"
      ? `Nothing was sent from ${text.email}. Google did not confirm a step before the send, so ${advice}`
      : `${message} ${advice[0]!.toUpperCase()}${advice.slice(1)}`;
  };
  const audit = unknown ? null : entry.outcome;
  return {
    audit,
    reason: audit === "refused" || audit === "failed" ? failure.code : null,
    error:
      when.approved && unknown
        ? null
        : {
            code: failure.code,
            message: describe(
              failure.said ??
                fileMessage ??
                (failure.reason === "arguments_too_large"
                  ? "The arguments are too large. The limit is 256 KB."
                  : failure.field
                    ? `The ${failure.field.name} field must be ${failure.field.expects}.`
                    : failure.missing
                      ? missingMessage(failure.missing, text.email)
                      : failure.over
                        ? "text" in failure.over
                          ? "The text of the original message cannot be carried whole: it is too large, or its HTML could not be converted."
                          : "bytes" in failure.over
                            ? `This message would have ${failure.over.bytes.toLocaleString("en-US")} bytes of attachments and text. The limit is ${failure.over.limit.toLocaleString("en-US")} bytes.`
                            : `This message would have ${failure.over.attachments} attachments. The limit is ${failure.over.limit}.`
                        : failure.unsendable
                          ? failure.unsendable.draft === null
                            ? `Gmail refused this message from ${text.email}. The usual cause is an address that is not valid.`
                            : `Gmail refused to send draft "${failure.unsendable.draft}" from ${text.email}. The usual cause is a draft with no recipient or with an address that is not valid. The owner can complete it in Gmail.`
                          : message),
            ),
          },
  };
}

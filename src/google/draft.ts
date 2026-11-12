import { Effect, Schema } from "effect";
import type { Send } from "../mcp/tools";
import { messageTooLarge, notFound, notSendable, ToolFailure } from "../mcp/failures";
import type { Created } from "../once/store";
import { RawMessage } from "./message";
import { change, get, upload } from "./gmail";

export type CreatedDraft = Created & { draft: string };

const Draft = Schema.Struct({
  id: Schema.String,
  message: Schema.Struct({ id: Schema.String, threadId: Schema.String }),
});
export const createDraft = (
  send: Send,
  input: { raw: string; thread?: string },
  refused: (status: number) => ToolFailure = () => new ToolFailure({ code: "google_unavailable" }),
): Effect.Effect<CreatedDraft, ToolFailure> =>
  change(send, "POST", "drafts", Draft, refused, {
    message: { raw: input.raw, ...(input.thread === undefined ? {} : { threadId: input.thread }) },
  }).pipe(
    Effect.map((draft) => ({
      draft: draft.id,
      message: draft.message.id,
      thread: draft.message.threadId,
    })),
  );

export const uploadDraft = (
  send: Send,
  input: { message: Blob; thread?: string },
): Effect.Effect<CreatedDraft, ToolFailure> => {
  const boundary = `related-${crypto.randomUUID()}`;
  const metadata = input.thread === undefined ? {} : { message: { threadId: input.thread } };
  const body = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`,
    `--${boundary}\r\nContent-Type: message/rfc822\r\n\r\n`,
    input.message,
    `\r\n--${boundary}--\r\n`,
  ]);
  return upload(
    send,
    "drafts?uploadType=multipart",
    Draft,
    (status) =>
      status === 413
        ? messageTooLarge(null)
        : status === 400
          ? notSendable(null)
          : new ToolFailure({ code: "google_unavailable" }),
    body,
    `multipart/related; boundary=${boundary}`,
  ).pipe(
    Effect.map((draft) => ({
      draft: draft.id,
      message: draft.message.id,
      thread: draft.message.threadId,
    })),
  );
};
export const readDraft = (send: Send, draft: string): Effect.Effect<RawMessage, ToolFailure> =>
  get(send, `drafts/${draft}?format=full`, Schema.Struct({ message: RawMessage }), (status) =>
    status === 404 || status === 400
      ? notFound("draft", draft)
      : new ToolFailure({ code: "google_unavailable" }),
  ).pipe(Effect.map((draft) => draft.message));

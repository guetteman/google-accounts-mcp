import { Buffer } from "node:buffer";
import { Effect } from "effect";
import { notFound, ToolFailure } from "../mcp/failures";
import type { Send } from "../mcp/tools";
import { AttachmentBytes, get } from "./gmail";
import {
  attachmentFields,
  attachmentPart,
  header,
  RawMessage,
  type RawPart,
  type Attachment,
} from "./message";
import { shorten } from "./bounds";

const unavailable = () => new ToolFailure({ code: "google_unavailable" });
export interface Found extends Attachment {
  part: RawPart;
  contentId: string;
  charset: string | null;
  from: string;
  subject: string;
  date: number;
}
export const findAttachment = (
  send: Send,
  input: { message: string; attachment: string },
): Effect.Effect<Found, ToolFailure> =>
  Effect.gen(function* () {
    const raw = yield* get(
      send,
      `messages/${encodeURIComponent(input.message)}?format=full`,
      RawMessage,
      (status) =>
        status === 404 || status === 400 ? notFound("message", input.message) : unavailable(),
    );
    const part = attachmentPart(raw, input.attachment);
    if (part === null) return yield* Effect.fail(notFound("attachment", input.attachment));
    const charset = /;\s*charset\s*=\s*(?:"([^"]*)"|'([^']*)'|([^;\s]*))/i.exec(
      header(part.headers, "Content-Type"),
    );
    return {
      part,
      ...attachmentFields(part),
      charset: charset === null ? null : shorten(charset[1] ?? charset[2] ?? charset[3]!, 40),
      from: header(raw.payload.headers, "From"),
      subject: header(raw.payload.headers, "Subject"),
      date: Number(raw.internalDate),
    };
  });

/** The attachment ID is from this message read, never from a previous read_thread response. */
export const partBytes = (send: Send, message: string, part: RawPart) =>
  Effect.gen(function* () {
    let data = part.body.data;
    if (data === undefined && part.body.attachmentId !== undefined) {
      const answer = yield* get(
        send,
        `messages/${encodeURIComponent(message)}/attachments/${encodeURIComponent(part.body.attachmentId)}`,
        AttachmentBytes,
        (status) => (status === 404 ? notFound("attachment", part.partId || "0") : unavailable()),
      );
      data = answer.data;
    }
    if (data === undefined) {
      if (part.body.size === 0) return new Uint8Array();
      return yield* Effect.fail(unavailable());
    }
    return yield* Effect.try({
      // atob validates base64; Buffer handles a large binary string without spreading its bytes.
      try: () =>
        new Uint8Array(Buffer.from(atob(data.replace(/-/g, "+").replace(/_/g, "/")), "binary")),
      catch: unavailable,
    });
  });

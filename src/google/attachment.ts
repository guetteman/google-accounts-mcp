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
/** MIME parameters end at semicolons outside quoted strings; names cannot supply a charset. */
const charsetOf = (value: string): string | null => {
  let start = 0;
  let quoted = false;
  let escaped = false;
  for (let i = 0; i <= value.length; i++) {
    const char = value[i];
    if (i < value.length) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (quoted && char === "\\") {
        escaped = true;
        continue;
      }
      if (char === '"') quoted = !quoted;
    }
    if (i !== value.length && (char !== ";" || quoted)) continue;
    const parameter = value.slice(start, i);
    start = i + 1;
    const equal = parameter.indexOf("=");
    if (equal < 0 || parameter.slice(0, equal).trim().toLowerCase() !== "charset") continue;
    let label = parameter.slice(equal + 1).trim();
    if (label.startsWith('"') && label.endsWith('"'))
      label = label.slice(1, -1).replace(/\\(.)/g, "$1");
    return shorten(label, 40);
  }
  return null;
};
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
    return {
      part,
      ...attachmentFields(part),
      charset: charsetOf(header(part.headers, "Content-Type")),
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
      try: () => {
        if (
          !/^[A-Za-z0-9_+/-]*={0,2}$/.test(data) ||
          data.length % 4 === 1 ||
          (data.endsWith("=") && data.length % 4 !== 0)
        )
          throw unavailable();
        const bytes = Buffer.from(data, "base64url");
        return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      },
      catch: unavailable,
    });
  });

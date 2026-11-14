import { Effect, Schema } from "effect";
import { messageTooLarge, ToolFailure } from "../mcp/failures";
import type { Send } from "../mcp/tools";
import { shorten, unfold } from "./bounds";
import { get, notFoundOr } from "./gmail";
import {
  attachmentParts,
  header,
  RawMessage,
  readMessage,
  otherParts,
  type RawPart,
} from "./message";
import { BodyBudget, textOf } from "./thread";
import { charsetOf, partBytes } from "./attachment";
import { fileFields, type FilePart } from "./mail";

export const MAX_FORWARD_BYTES = 25_000_000;
/**
 * Two original reads + up to 2 × 3 body parts + 20 attachments + one upload + one send +
 * one cleanup + one token refresh + 11 D1 round trips = 43, within the Workers Free limit of 50.
 */
export const MAX_FORWARD_FILES = 20;
export type ForwardPlan = {
  thread: string;
  subject: string;
  quoted: string;
  files: ReadonlyArray<{ part: RawPart; filename: string; type: string; size: number }>;
  omitted: number;
  original: { from: string; subject: string; date: number };
};
export const forwardPlan = (send: Send, message: string): Effect.Effect<ForwardPlan, ToolFailure> =>
  Effect.gen(function* () {
    const raw = yield* get(
      send,
      `messages/${message}?format=full`,
      Schema.Struct({ ...RawMessage.fields, threadId: Schema.String }),
      notFoundOr("message", message),
    );
    const parsed = yield* Effect.try({
      try: () => readMessage(raw),
      catch: () => new ToolFailure({ code: "google_unavailable" }),
    });
    const body = yield* textOf(send, parsed, new BodyBudget());
    if (!body.whole) return yield* Effect.fail(messageTooLarge({ text: true }));
    const subject = unfold(header(raw.payload.headers, "Subject"));
    const quoted = [
      "---------- Forwarded message ---------",
      `From: ${unfold(parsed.from)}`,
      `Date: ${unfold(parsed.date)}`,
      `Subject: ${shorten(subject, 500)}`,
      `To: ${parsed.to.map(unfold).join(", ")}`,
      ...(parsed.cc.length ? [`Cc: ${parsed.cc.map(unfold).join(", ")}`] : []),
      "",
      body.text,
    ].join("\n");
    return {
      thread: raw.threadId,
      subject: `${/^fwd:/i.test(subject) ? "" : "Fwd: "}${shorten(subject, 1000)}`,
      quoted,
      files: attachmentParts(raw).map((part) => ({
        part,
        ...fileFields({ filename: part.filename, type: part.mimeType }),
        size: part.body.size,
      })),
      omitted: otherParts(raw).length,
      original: {
        from: unfold(parsed.from),
        subject: shorten(subject, 500),
        date: Number(raw.internalDate),
      },
    };
  });

/** Check metadata before downloading, then check the actual bytes before retaining each file. */
export const forwardFiles = (
  send: Send,
  message: string,
  plan: ForwardPlan,
  textBytes: number,
): Effect.Effect<FilePart[], ToolFailure> =>
  Effect.gen(function* () {
    if (plan.files.length > MAX_FORWARD_FILES)
      return yield* Effect.fail(
        messageTooLarge({ attachments: plan.files.length, limit: MAX_FORWARD_FILES }),
      );
    const expected = textBytes + plan.files.reduce((sum, file) => sum + file.size, 0);
    if (expected > MAX_FORWARD_BYTES)
      return yield* Effect.fail(messageTooLarge({ bytes: expected, limit: MAX_FORWARD_BYTES }));
    let size = textBytes;
    const files: FilePart[] = [];
    for (const file of plan.files) {
      const bytes = yield* partBytes(send, message, file.part);
      size += bytes.byteLength;
      if (size > MAX_FORWARD_BYTES)
        return yield* Effect.fail(messageTooLarge({ bytes: size, limit: MAX_FORWARD_BYTES }));
      const charset = charsetOf(header(file.part.headers, "Content-Type"));
      files.push({
        filename: file.filename,
        type: file.type,
        bytes,
        ...(charset === null ? {} : { charset }),
      });
    }
    return files;
  });

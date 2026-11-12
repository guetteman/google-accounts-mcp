import { Effect, Schema } from "effect";
import { messageTooLarge, notFound, ToolFailure } from "../mcp/failures";
import type { Send } from "../mcp/tools";
import { shorten } from "./bounds";
import { get } from "./gmail";
import { attachmentParts, header, RawMessage, readMessage, type RawPart } from "./message";
import { BodyBudget, textOf } from "./thread";
import { partBytes } from "./attachment";
import type { FilePart } from "./mail";

export const MAX_FORWARD_BYTES = 25_000_000;
export const MAX_FORWARD_FILES = 30;
export type ForwardPlan = {
  thread: string;
  subject: string;
  quoted: string;
  files: ReadonlyArray<{ part: RawPart; filename: string; type: string; size: number }>;
  original: { from: string; subject: string; date: number };
};
export const forwardPlan = (send: Send, message: string): Effect.Effect<ForwardPlan, ToolFailure> =>
  Effect.gen(function* () {
    const raw = yield* get(
      send,
      `messages/${message}?format=full`,
      Schema.Struct({ ...RawMessage.fields, threadId: Schema.String }),
      (status) =>
        status === 404 || status === 400
          ? notFound("message", message)
          : new ToolFailure({ code: "google_unavailable" }),
    );
    const parsed = yield* Effect.try({
      try: () => readMessage(raw),
      catch: () => new ToolFailure({ code: "google_unavailable" }),
    });
    const body = yield* textOf(send, parsed, new BodyBudget());
    const subject = header(raw.payload.headers, "Subject");
    const quoted = [
      "---------- Forwarded message ---------",
      `From: ${parsed.from}`,
      `Date: ${parsed.date}`,
      `Subject: ${shorten(subject, 500)}`,
      `To: ${parsed.to.join(", ")}`,
      ...(parsed.cc.length ? [`Cc: ${parsed.cc.join(", ")}`] : []),
      "",
      body.text,
    ].join("\n");
    return {
      thread: raw.threadId,
      subject: `${/^fwd:/i.test(subject) ? "" : "Fwd: "}${shorten(subject, 1000)}`,
      quoted,
      files: attachmentParts(raw).map((part) => ({
        part,
        filename: part.filename,
        type: part.mimeType,
        size: part.body.size,
      })),
      original: {
        from: parsed.from,
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
      return yield* Effect.fail(messageTooLarge({ attachments: plan.files.length }));
    const expected = textBytes + plan.files.reduce((sum, file) => sum + file.size, 0);
    if (expected > MAX_FORWARD_BYTES)
      return yield* Effect.fail(messageTooLarge({ bytes: expected }));
    let size = textBytes;
    const files: FilePart[] = [];
    for (const file of plan.files) {
      const bytes = yield* partBytes(send, message, file.part);
      size += bytes.byteLength;
      if (size > MAX_FORWARD_BYTES) return yield* Effect.fail(messageTooLarge({ bytes: size }));
      files.push({ filename: file.filename, type: file.type, bytes });
    }
    return files;
  });

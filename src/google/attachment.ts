import { Effect, Schema } from "effect";
import { notFound, ToolFailure } from "../mcp/failures";
import type { Send } from "../mcp/tools";
import type { RawPart } from "./message";
import { get } from "./gmail";

/** Read a file's bytes; the caller owns its size budget. */
export const partBytes = (
  send: Send,
  message: string,
  part: RawPart,
): Effect.Effect<Uint8Array, ToolFailure> =>
  Effect.gen(function* () {
    const unavailable = () => new ToolFailure({ code: "google_unavailable" });
    const data =
      part.body.data !== undefined
        ? part.body.data
        : part.body.attachmentId !== undefined
          ? (yield* get(
              send,
              `messages/${encodeURIComponent(message)}/attachments/${encodeURIComponent(part.body.attachmentId)}`,
              Schema.Struct({ data: Schema.String }),
              (status) =>
                status === 404 ? notFound("attachment", part.partId || "0") : unavailable(),
            )).data
          : part.body.size === 0
            ? ""
            : null;
    return yield* Effect.try({
      try: () => {
        if (data === null || !/^[A-Za-z0-9_-]*={0,2}$/.test(data))
          throw new Error("Invalid attachment bytes");
        const length = data.length - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
        if (length % 4 === 1 || (length !== data.length && data.length % 4 !== 0))
          throw new Error("Invalid attachment bytes");
        const bytes = new Uint8Array(Math.floor((length * 3) / 4));
        let offset = 0;
        // Decode in aligned blocks, without a whole second base64 or binary string.
        for (let at = 0; at < length; at += 32768) {
          const block = atob(
            data
              .slice(at, Math.min(at + 32768, length))
              .replaceAll("-", "+")
              .replaceAll("_", "/"),
          );
          for (let i = 0; i < block.length; i++) bytes[offset++] = block.charCodeAt(i);
        }
        return bytes;
      },
      catch: unavailable,
    });
  });

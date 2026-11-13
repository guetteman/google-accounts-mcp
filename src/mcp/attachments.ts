import { Effect, Schema } from "effect";
import { viewDate, type ViewValue } from "../approvals/model";
import { findAttachment, partBytes } from "../google/attachment";
import { shorten } from "../google/bounds";
import { MAX_FORWARD_BYTES } from "../google/forward";
import { fileFields, type FilePart } from "../google/mail";
import { normalizeEmail } from "../owner/owner";
import { parseUploadId } from "../uploads/store";
import { messageTooLarge, ToolFailure, uploadNotAvailable } from "./failures";
import { TOOLS, type Sources } from "./tools";

// An approved reply with 10 copies uses at most 48 requests: 3 reads per copy,
// 2 reply reads, upload/send, 2 refreshes, and at most 12 D1 operations (contract T3).
export const MAX_ATTACHMENTS = 10;
const Id = Schema.String.check(Schema.isBetweenLength(1, 64), Schema.isPattern(/^[A-Za-z0-9_-]+$/));
const Copy = Schema.Struct({
  account: Schema.String,
  message: Id,
  attachment: Schema.String.check(
    Schema.isBetweenLength(1, 64),
    Schema.isPattern(/^[0-9]+(?:\.[0-9]+)*$/),
  ),
});
const Upload = Schema.Struct({
  upload: Schema.String.check(Schema.makeFilter((id) => parseUploadId(id) !== null)),
});
export const Attachments = Schema.Array(Schema.Union([Copy, Upload])).check(
  Schema.isMaxLength(MAX_ATTACHMENTS),
  Schema.makeFilter((items) => {
    const uploads = items.flatMap((item) => ("upload" in item ? [item.upload] : []));
    return new Set(uploads).size === uploads.length;
  }),
);
export type Item = typeof Copy.Type | typeof Upload.Type;
export const alsoOf = (
  items: readonly Item[] | undefined,
): ReadonlyArray<{ account: string; tool: "get_attachment" }> => {
  const seen = new Set<string>();
  return (items ?? []).flatMap((item) => {
    if ("upload" in item) return [];
    const key = normalizeEmail(item.account) ?? item.account;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ account: item.account, tool: "get_attachment" as const }];
  });
};
export const uploadsOf = (items: readonly Item[] | undefined): readonly string[] =>
  (items ?? []).flatMap((item) => ("upload" in item ? [item.upload] : []));
export const attachingTools = () =>
  TOOLS.filter((tool) => tool.kind === "account" && tool.uploads).map((tool) => tool.name);
export const withUploadAdvice = (text: string, uploads: readonly string[]) =>
  uploads.length
    ? text.replace(/(call again with duplicate: \d+)\./g, "$1 and a new upload of each file.")
    : text;
export const checkAttachedSize = (sizes: Iterable<number>, textBytes: number) => {
  let bytes = textBytes;
  for (const size of sizes) bytes += size;
  return bytes > MAX_FORWARD_BYTES
    ? Effect.fail(messageTooLarge({ bytes, limit: MAX_FORWARD_BYTES }))
    : Effect.void;
};
type Planned = {
  filename: string;
  type: string;
  size: number;
  charset?: string | null;
  source:
    | { kind: "upload" }
    | { kind: "copy"; account: string; from: string; subject: string; date: number };
  bytes: Effect.Effect<Uint8Array<ArrayBuffer>, ToolFailure>;
};
/** One plan gives both the approval's facts and the MIME part's fields. */
const plan = (items: readonly Item[], sources: Sources): Effect.Effect<Planned[], ToolFailure> =>
  Effect.forEach(
    items,
    (item) =>
      Effect.gen(function* () {
        if ("upload" in item) {
          const file = sources.uploads.get(item.upload);
          if (!file) return yield* Effect.fail(uploadNotAvailable(item.upload));
          return { ...file, ...fileFields(file), source: { kind: "upload" as const } };
        }
        const about = {
          input: item.account,
          email: normalizeEmail(item.account) ?? item.account,
          tool: "get_attachment",
        };
        const stamp = (failure: ToolFailure) => {
          const data: ConstructorParameters<typeof ToolFailure>[0] = failure;
          return new ToolFailure({ ...data, about });
        };
        const send = sources.from(item.account);
        const found = yield* findAttachment(send, item).pipe(Effect.mapError(stamp));
        return {
          ...fileFields(found),
          size: found.size,
          charset: found.charset,
          source: {
            kind: "copy" as const,
            account: item.account,
            from: found.from,
            subject: found.subject,
            date: found.date,
          },
          bytes: partBytes(send, item.message, found.part).pipe(Effect.mapError(stamp)),
        };
      }),
    { concurrency: "unbounded" },
  );
export const attachmentValues = (items: readonly Item[], sources: Sources) =>
  Effect.gen(function* () {
    if (!items.length) return [];
    const files = yield* plan(items, sources);
    const values: ViewValue[] = [
      {
        name: "Attachments",
        text: `${files.length} files, ${files.reduce((sum, file) => sum + file.size, 0).toLocaleString("en-US")} bytes in all`,
        from: files.some((file) => file.source.kind === "upload") ? "agent" : "gmail",
      },
    ];
    for (const [i, file] of files.entries()) {
      const prefix = `Attachment ${i + 1}`;
      const copied = file.source.kind === "copy";
      values.push({
        name: `${prefix} (${copied ? "copied" : "sent to a link of this connection"})`,
        text: `${file.filename || "(no name)"} (${file.type}, ${file.size.toLocaleString("en-US")} bytes)`,
        from: copied ? "gmail" : "agent",
      });
      if (file.source.kind === "copy")
        values.push(
          { name: `${prefix} is copied from`, text: file.source.account, from: "agent" },
          { name: `${prefix} message from`, text: shorten(file.source.from, 500), from: "gmail" },
          {
            name: `${prefix} message subject`,
            text: shorten(file.source.subject, 500),
            from: "gmail",
          },
          { name: `${prefix} message date`, text: viewDate(file.source.date), from: "gmail" },
        );
    }
    return values;
  });
export const attachedFiles = (
  items: readonly Item[],
  sources: Sources,
  textBytes: number,
): Effect.Effect<readonly FilePart[], ToolFailure> =>
  Effect.gen(function* () {
    const files = yield* plan(items, sources);
    yield* checkAttachedSize(
      files.map((file) => file.size),
      textBytes,
    );
    const parts = yield* Effect.forEach(
      files,
      (file) =>
        file.bytes.pipe(
          Effect.map((bytes) => ({
            filename: file.filename,
            type: file.type,
            ...(file.charset ? { charset: file.charset } : {}),
            bytes,
          })),
        ),
      { concurrency: "unbounded" },
    );
    yield* checkAttachedSize(
      parts.map((file) => file.bytes.byteLength),
      textBytes,
    );
    for (const [i, file] of files.entries()) {
      if (parts[i]!.bytes.byteLength !== file.size)
        return yield* Effect.fail(
          new ToolFailure({
            code: "google_unavailable",
            ...(file.source.kind === "copy"
              ? {
                  about: {
                    input: file.source.account,
                    email: normalizeEmail(file.source.account) ?? file.source.account,
                    tool: "get_attachment",
                  },
                }
              : {}),
          }),
        );
    }
    return parts;
  });
export const attachmentsDescription =
  "`attachments` is an optional list of at most 10 files. An item is `{ account, message, attachment }`, which copies an attachment that read_thread listed for a message, from any account you can use; the file goes from Gmail into this mail and never appears in a result. It needs the owner's setting for get_attachment on that account. Or an item is `{ upload }`, which names a local file by the `upload` ID that the link of create_upload_link answered. An upload goes into one message: repeating this call with the same arguments is safe, and once the mail exists any other call needs a new upload. The attachments and the text together can have at most 25 MB.";
export const attachmentsExpect =
  "a list of at most 10 files, each { account, message, attachment } or { upload }, with no repeated upload";

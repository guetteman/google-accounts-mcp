import { Buffer } from "node:buffer";
import type { CallToolResult } from "@modelcontextprotocol/server";
import type { FileData } from "../files/store";
import { notReadable } from "./failures";

export const MAX_ATTACHMENT_BYTES = 12_000_000;
export class WithFile {
  constructor(
    readonly value: unknown,
    readonly file: FileData,
  ) {}
}
export type Reader = { client: string | null } | "later";
export type Takes = (type: string) => boolean;
type Form = "resource" | "image" | "text";
// The same policy controls the pre-download check, collection and MCP rendering.
const forms: ReadonlyArray<{ form: Form; takes: (reader: Reader, type: string) => boolean }> = [
  { form: "resource", takes: (reader) => reader === "later" || reader.client === "claude-code" },
  {
    form: "image",
    takes: (_reader, type) => ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(type),
  },
  { form: "text", takes: (_reader, type) => type.startsWith("text/") },
];
const formOf = (reader: Reader, type: string): Form | null =>
  forms.find((entry) => entry.takes(reader, type.toLowerCase()))?.form ?? null;
export const takes =
  (reader: Reader): Takes =>
  (type) =>
    formOf(reader, type) !== null;
const textOf = (file: FileData): string => {
  let utf8: string | undefined;
  try {
    utf8 = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
  } catch {
    // Invalid UTF-8 may still decode in the declared charset.
  }
  // ISO-2022-JP escapes and UTF-16 NULs can be valid UTF-8 without being its intended text.
  if (
    utf8 !== undefined &&
    (file.charset === null || (!utf8.includes("\u0000") && !utf8.includes("\u001b")))
  )
    return utf8;
  if (file.charset !== null) {
    try {
      return new TextDecoder(file.charset, { fatal: true }).decode(file.bytes);
    } catch {
      // An unknown charset or invalid text in it leaves the file unreadable.
    }
  }
  throw notReadable({ ...file, size: file.bytes.byteLength });
};
export const contentOf = (value: unknown, reader: Reader): CallToolResult["content"] => {
  if (!(value instanceof WithFile)) return [{ type: "text", text: JSON.stringify(value) }];
  const { file } = value;
  const form = formOf(reader, file.type);
  if (form === null) throw notReadable({ ...file, size: file.bytes.byteLength });
  const metadata = { type: "text" as const, text: JSON.stringify(value.value) };
  if (form === "text") return [metadata, { type: "text", text: textOf(file) }];
  const base64 = Buffer.from(
    file.bytes.buffer,
    file.bytes.byteOffset,
    file.bytes.byteLength,
  ).toString("base64");
  if (form === "image")
    return [metadata, { type: "image", data: base64, mimeType: file.type.toLowerCase() }];
  return [
    metadata,
    {
      type: "resource",
      resource: {
        uri: `attachment://file/${encodeURIComponent(file.filename.toWellFormed())}`,
        mimeType: file.type,
        blob: base64,
      },
    },
  ];
};

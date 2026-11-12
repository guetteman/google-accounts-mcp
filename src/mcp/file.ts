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
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
  } catch {
    if (file.charset !== null) {
      try {
        return new TextDecoder(file.charset, { fatal: true }).decode(file.bytes);
      } catch {
        // A missing, unknown or unsuccessful fallback is an unreadable text file.
      }
    }
    throw notReadable({ ...file, size: file.bytes.byteLength });
  }
};
export const readable = (reader: Reader, file: FileData): boolean => {
  const form = formOf(reader, file.type);
  if (form === null) return false;
  if (form !== "text") return true;
  try {
    textOf(file);
    return true;
  } catch {
    return false;
  }
};
export const contentOf = (value: unknown, reader: Reader): CallToolResult["content"] => {
  if (!(value instanceof WithFile)) return [{ type: "text", text: JSON.stringify(value) }];
  const { file } = value;
  const form = formOf(reader, file.type);
  if (form === null) throw notReadable({ ...file, size: file.bytes.byteLength });
  const metadata = { type: "text" as const, text: JSON.stringify(value.value) };
  if (form === "text") return [metadata, { type: "text", text: textOf(file) }];
  const base64 = Buffer.from(file.bytes).toString("base64");
  if (form === "image") return [metadata, { type: "image", data: base64, mimeType: file.type }];
  // Only get_attachment and get_approval construct WithFile; both retain this metadata.
  const first = value.value as { result?: unknown };
  const result = (first.result ?? first) as { message: string; attachment: string };
  return [
    metadata,
    {
      type: "resource",
      resource: {
        uri: `attachment://${result.message}/${result.attachment}`,
        mimeType: file.type,
        blob: base64,
      },
    },
  ];
};

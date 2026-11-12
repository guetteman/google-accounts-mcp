import { Buffer } from "node:buffer";
import { Effect, Schema } from "effect";
import { Unavailable } from "../db";

export interface FileData {
  bytes: Uint8Array<ArrayBuffer>;
  filename: string;
  type: string;
  charset: string | null;
}
export const FileRef = Schema.Struct({
  v: Schema.Literal(1),
  name: Schema.String.check(
    Schema.isPattern(/^file:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
  ),
  key: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/)),
  filename: Schema.String,
  type: Schema.String,
  charset: Schema.NullOr(Schema.String),
});
export type FileRef = typeof FileRef.Type;
const encoder = new TextEncoder();

/** Each file has its own key, so deleting its sealed reference makes the bytes impossible to decrypt. */
export const putFile = (kv: KVNamespace, file: FileData, expires: number) =>
  Effect.tryPromise({
    try: async (): Promise<FileRef> => {
      const name = `file:${crypto.randomUUID()}`;
      const key = crypto.getRandomValues(new Uint8Array(32));
      const imported = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["encrypt"]);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const encrypted = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: encoder.encode(name) },
        imported,
        file.bytes,
      );
      const value = new Uint8Array(iv.length + encrypted.byteLength);
      value.set(iv);
      value.set(new Uint8Array(encrypted), iv.length);
      await kv.put(name, value, { expiration: Math.floor(expires / 1000) + 60 });
      return {
        v: 1,
        name,
        key: Buffer.from(key).toString("base64url"),
        filename: file.filename,
        type: file.type,
        charset: file.charset,
      };
    },
    catch: () => new Unavailable(),
  });

/** A miss, an unavailable location and a damaged value all mean the file is not ready. */
export const getFile = (kv: KVNamespace, ref: FileRef): Effect.Effect<FileData | null> =>
  Effect.promise(async () => {
    try {
      const stored = await kv.get(ref.name, "arrayBuffer");
      if (stored === null) return null;
      const value = new Uint8Array(stored);
      const key = await crypto.subtle.importKey(
        "raw",
        Buffer.from(ref.key, "base64url"),
        "AES-GCM",
        false,
        ["decrypt"],
      );
      const bytes = new Uint8Array(
        await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: value.subarray(0, 12), additionalData: encoder.encode(ref.name) },
          key,
          value.subarray(12),
        ),
      );
      return { bytes, filename: ref.filename, type: ref.type, charset: ref.charset };
    } catch {
      return null;
    }
  });

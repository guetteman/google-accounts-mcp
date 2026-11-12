import { env } from "cloudflare:workers";
import { Buffer } from "node:buffer";
import { Effect, Schema } from "effect";
import { expect, it } from "vite-plus/test";
import { FileRef, getFile, putFile } from "../src/files/store";
import { failingKv } from "./support/db";

const file = (bytes = new Uint8Array([0, 128, 254, 255, 13, 10])) => ({
  bytes,
  filename: "notes.txt",
  type: "text/plain",
  charset: "iso-8859-1",
});
const expiry = () => Date.now() + 3_600_000;

it("round trips 12,000,000 bytes with metadata and expiry through encrypted KV", async () => {
  const original = file(Uint8Array.from({ length: 12_000_000 }, (_, i) => (i * 31 + 1) % 256));
  const expires = expiry();
  const ref = await Effect.runPromise(putFile(env.FILES_KV, original, expires));
  expect(Schema.is(FileRef)(ref)).toBe(true);
  expect(ref).toMatchObject({
    v: 1,
    filename: "notes.txt",
    type: "text/plain",
    charset: "iso-8859-1",
  });
  const opened = await Effect.runPromise(getFile(env.FILES_KV, ref));
  expect(opened).not.toBeNull();
  expect({ ...opened, bytes: undefined }).toEqual({ ...original, bytes: undefined });
  expect(Buffer.from(await crypto.subtle.digest("SHA-256", opened!.bytes))).toEqual(
    Buffer.from(await crypto.subtle.digest("SHA-256", original.bytes)),
  );
  expect((await env.FILES_KV.list()).keys).toEqual([
    { name: ref.name, expiration: Math.floor(expires / 1000) + 60 },
  ]);
  expect(Buffer.from((await env.FILES_KV.get(ref.name, "arrayBuffer"))!)).not.toEqual(
    Buffer.from(original.bytes),
  );
});

it("uses different names, keys and ciphertext for identical bytes without plaintext in KV", async () => {
  const original = file(new TextEncoder().encode("PRIVATE_FILE_MARKER_".repeat(30)));
  const a = await Effect.runPromise(putFile(env.FILES_KV, original, expiry()));
  const b = await Effect.runPromise(putFile(env.FILES_KV, original, expiry()));
  expect(a.name).not.toBe(b.name);
  expect(a.key).not.toBe(b.key);
  const stored = await Promise.all([a, b].map((ref) => env.FILES_KV.get(ref.name, "arrayBuffer")));
  const values = stored.map((bytes) => Buffer.from(bytes!));
  expect(values[0]).not.toEqual(values[1]);
  for (const value of values) {
    expect(value.includes(Buffer.from(original.bytes))).toBe(false);
    expect(value.includes(Buffer.from("PRIVATE_FILE_MARKER_"))).toBe(false);
  }
});

it("treats a wrong key, swapped name, damaged value, missing value and KV failure as absent", async () => {
  const a = await Effect.runPromise(putFile(env.FILES_KV, file(), expiry()));
  const b = await Effect.runPromise(putFile(env.FILES_KV, file(), expiry()));
  expect(await Effect.runPromise(getFile(env.FILES_KV, { ...a, key: b.key }))).toBeNull();
  const value = new Uint8Array((await env.FILES_KV.get(a.name, "arrayBuffer"))!);
  await env.FILES_KV.put(b.name, value);
  expect(await Effect.runPromise(getFile(env.FILES_KV, { ...a, name: b.name }))).toBeNull();
  value[value.length - 1] = value[value.length - 1]! ^ 1;
  await env.FILES_KV.put(a.name, value);
  expect(await Effect.runPromise(getFile(env.FILES_KV, a))).toBeNull();
  expect(
    await Effect.runPromise(getFile(env.FILES_KV, { ...a, name: `file:${crypto.randomUUID()}` })),
  ).toBeNull();
  expect(await Effect.runPromise(getFile(failingKv("all", env.FILES_KV), a))).toBeNull();
});

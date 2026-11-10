import type { TokenKey } from "./config";
export type Sealed = string & { readonly __sealed: unique symbol };
const encoder = new TextEncoder();
const imported = new Map<string, CryptoKey>();
const encode = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
const decode = (value: string) =>
  Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));
export async function keyId(bytes: TokenKey): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest.slice(0, 8), (b) => b.toString(16).padStart(2, "0")).join("");
}
async function keyInfo(bytes: TokenKey) {
  const id = await keyId(bytes);
  let key = imported.get(id);
  if (!key) {
    key = await crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
    imported.set(id, key);
  }
  return { id, key };
}
export async function seal(key: TokenKey, context: string, plaintext: string): Promise<Sealed> {
  const info = await keyInfo(key);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(context) },
    info.key,
    encoder.encode(plaintext),
  );
  return `v1.${info.id}.${encode(iv)}.${encode(new Uint8Array(ciphertext))}` as Sealed;
}
export type Opened =
  | { ok: true; value: string }
  | { ok: false; reason: "damaged" | "other_key" | "unavailable" };
export async function open(key: TokenKey, context: string, sealed: Sealed): Promise<Opened> {
  const [version, id, nonce, value, ...rest] = sealed.split(".");
  if (version !== "v1") return { ok: false, reason: "unavailable" };
  let iv: Uint8Array<ArrayBuffer>, ciphertext: Uint8Array<ArrayBuffer>;
  try {
    if (
      !id ||
      !/^[a-f0-9]{16}$/.test(id) ||
      !nonce ||
      !value ||
      rest.length ||
      !/^[\w-]+$/.test(nonce + value)
    )
      return { ok: false, reason: "damaged" };
    iv = decode(nonce);
    ciphertext = decode(value);
    if (iv.length !== 12 || ciphertext.length < 16) return { ok: false, reason: "damaged" };
  } catch {
    return { ok: false, reason: "damaged" };
  }
  let info: Awaited<ReturnType<typeof keyInfo>>;
  try {
    info = await keyInfo(key);
  } catch {
    return { ok: false, reason: "unavailable" };
  }
  if (id !== info.id) return { ok: false, reason: "other_key" };
  try {
    return {
      ok: true,
      value: new TextDecoder().decode(
        await crypto.subtle.decrypt(
          { name: "AES-GCM", iv, additionalData: encoder.encode(context) },
          info.key,
          ciphertext,
        ),
      ),
    };
  } catch (error) {
    // With the envelope, nonce, key and tag size validated, OperationError means authentication failed.
    return {
      ok: false,
      reason:
        error instanceof DOMException && error.name === "OperationError"
          ? "damaged"
          : "unavailable",
    };
  }
}

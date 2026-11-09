import type { TokenKey } from "./config";
export type Sealed = string & { readonly __sealed: unique symbol };
const encoder = new TextEncoder();
const imported = new Map<string, Promise<CryptoKey>>();
const encode = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
const decode = (value: string) =>
  Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));
async function keyInfo(bytes: TokenKey) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const id = Array.from(digest.slice(0, 8), (b) => b.toString(16).padStart(2, "0")).join("");
  let key = imported.get(id);
  if (!key) {
    key = crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
    imported.set(id, key);
  }
  return { id, key: await key };
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
export type Opened = { ok: true; value: string } | { ok: false; reason: "damaged" | "other_key" };
export async function open(key: TokenKey, context: string, sealed: Sealed): Promise<Opened> {
  try {
    const [version, id, nonce, value, ...rest] = sealed.split(".");
    if (
      version !== "v1" ||
      !id ||
      !nonce ||
      !value ||
      rest.length ||
      !/^[\w-]+$/.test(nonce + value)
    )
      return { ok: false, reason: "damaged" };
    const info = await keyInfo(key);
    const iv = decode(nonce);
    if (iv.length !== 12) return { ok: false, reason: "damaged" };
    if (id !== info.id) return { ok: false, reason: "other_key" };
    return {
      ok: true,
      value: new TextDecoder().decode(
        await crypto.subtle.decrypt(
          { name: "AES-GCM", iv, additionalData: encoder.encode(context) },
          info.key,
          decode(value),
        ),
      ),
    };
  } catch {
    return { ok: false, reason: "damaged" };
  }
}

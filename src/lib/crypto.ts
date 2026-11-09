export function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function decodeBase64url(value: string): string {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  return new TextDecoder("utf-8", { fatal: true }).decode(
    Uint8Array.from(atob(padded + "=".repeat((4 - (padded.length % 4)) % 4)), (c) =>
      c.charCodeAt(0),
    ),
  );
}

export const randomToken = () => base64url(crypto.getRandomValues(new Uint8Array(32)));
export const sha256 = (value: string) =>
  crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));

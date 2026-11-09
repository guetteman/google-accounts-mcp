export type ReturnPath = string & { readonly __returnPath: unique symbol };

// The return path travels in the sign-in's state cookie, and browsers drop a cookie over 4096
// bytes. A longer path falls back to the default instead of breaking the sign-in.
const MAX_LENGTH = 1024;

export function returnPath(raw: unknown, origin: string): ReturnPath {
  if (
    typeof raw === "string" &&
    raw.length <= MAX_LENGTH &&
    /^\/(?![/\\])/.test(raw) &&
    !Array.from(raw).some(
      (character) =>
        character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127 || character === "\\",
    )
  ) {
    const url = new URL(raw, origin);
    if (url.origin === origin && !url.pathname.startsWith("//"))
      return `${url.pathname}${url.search}${url.hash}` as ReturnPath;
  }
  return "/accounts" as ReturnPath;
}

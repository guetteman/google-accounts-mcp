export type ReturnPath = string & { readonly __returnPath: unique symbol };

export function returnPath(raw: unknown, origin: string): ReturnPath {
  if (
    typeof raw === "string" &&
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

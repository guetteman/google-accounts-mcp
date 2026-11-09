export type Name = string & { readonly __name: unique symbol };
export function parseName(raw: unknown): Name | null {
  if (typeof raw !== "string") return null;
  const name = raw.trim();
  const length = Array.from(name).length;
  return length >= 1 && length <= 100 ? (name as Name) : null;
}

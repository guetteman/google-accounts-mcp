import type { AccountId } from "../accounts/model";
import type { TokenKey } from "../config";
import type { ConnectionId } from "../connections/model";
import type { AccountTool } from "../mcp/tools";

export type Identity = string & { readonly __identity: unique symbol };

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, value]) => value !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, value]) => [key, canonical(value)]),
    );
  return value;
};

export const identityOf = async (
  key: TokenKey,
  call: {
    connection: ConnectionId;
    account: AccountId;
    tool: AccountTool;
    args: Readonly<Record<string, unknown>>;
    defaults: Readonly<Record<string, unknown>>;
  },
): Promise<Identity> => {
  const args = JSON.stringify(
    canonical(
      Object.fromEntries(
        Object.entries(call.args).filter(
          ([field, value]) =>
            field !== "account" &&
            value !== undefined &&
            JSON.stringify(canonical(value)) !== JSON.stringify(canonical(call.defaults[field])),
        ),
      ),
    ),
  );
  const encoder = new TextEncoder();
  const material = await crypto.subtle.importKey("raw", key, "HKDF", false, ["deriveKey"]);
  const signing = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(), info: encoder.encode("same-call v1") },
    material,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    signing,
    encoder.encode(JSON.stringify([call.connection, call.account, call.tool, args])),
  );
  return ("v1." +
    Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join(
      "",
    )) as Identity;
};

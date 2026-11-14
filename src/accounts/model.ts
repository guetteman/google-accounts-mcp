import { normalizeEmail } from "../owner/owner";
import type { Sealed } from "../seal";
import { GMAIL_SCOPES, type GmailScopes } from "../google/client";
import { Data, Schema } from "effect";
export type AccountId = string & { readonly __accountId: unique symbol };
export type Health = "ready" | "needs_reconnect" | "blocked_by_admin";
export interface Credential {
  readonly id: AccountId;
  readonly email: string;
  readonly version: number;
  readonly health: Health;
  readonly blockedUntil: number | null;
  readonly refreshToken: Sealed | null;
  readonly accessToken: Sealed | null;
  readonly accessExpiresAt: number | null;
}
export class NeedsReconnect extends Data.TaggedError("NeedsReconnect")<{
  readonly email: string;
}> {}
export class BlockedByAdmin extends Data.TaggedError("BlockedByAdmin")<{
  readonly email: string;
}> {}
export class AccountGone extends Data.TaggedError("AccountGone") {}
export class RequestLost extends Data.TaggedError("RequestLost") {}

export const parseAccountId = (value: unknown): AccountId | null =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
    ? (value as AccountId)
    : null;
export const newAccountId = (): AccountId => crypto.randomUUID() as AccountId;
export type AccountStatus =
  | { readonly kind: "unreadable" }
  | { readonly kind: "ready" }
  | { readonly kind: "needs_reconnect" }
  | { readonly kind: "blocked_by_admin" }
  | { readonly kind: "missing_access"; readonly granted: number };
export const accountStatus = (
  health: Health,
  scopes: GmailScopes,
  readable = true,
): AccountStatus =>
  !readable
    ? { kind: "unreadable" }
    : health !== "ready"
      ? { kind: health }
      : scopes.length < GMAIL_SCOPES.length
        ? { kind: "missing_access", granted: scopes.length }
        : { kind: "ready" };
export interface AccountView {
  readonly id: AccountId;
  readonly name: string;
  readonly email: string;
  readonly workspace: boolean;
  readonly status: AccountStatus;
}
// The accounts table's STRICT types and CHECK constraints already rule out a version below 1
// and a token that does not match the health; this decodes the row and checks the rest.
const CredentialRow = Schema.Struct({
  id: Schema.String,
  email: Schema.String,
  version: Schema.Int,
  health: Schema.Literals(["ready", "needs_reconnect", "blocked_by_admin"]),
  blocked_until: Schema.NullOr(Schema.Int),
  refresh_token: Schema.NullOr(Schema.String),
  access_token: Schema.NullOr(Schema.String),
  access_expires_at: Schema.NullOr(Schema.Int),
});
export function decodeCredential(raw: unknown): Credential | null {
  const parsed = Schema.decodeUnknownOption(CredentialRow)(raw);
  if (parsed._tag === "None") return null;
  const row = parsed.value;
  const id = parseAccountId(row.id);
  const email = normalizeEmail(row.email);
  if (
    !id ||
    !email ||
    email !== row.email ||
    (row.health === "blocked_by_admin" && row.blocked_until === null)
  )
    return null;
  return {
    id,
    email,
    version: row.version,
    health: row.health,
    blockedUntil: row.blocked_until,
    refreshToken: row.refresh_token as Sealed | null,
    accessToken: row.access_token as Sealed | null,
    accessExpiresAt: row.access_expires_at,
  };
}

export const accountMessage = (
  status: Exclude<AccountStatus["kind"], "ready">,
  email: string,
  origin: string,
): string => {
  switch (status) {
    case "needs_reconnect":
      return `Ask the owner to reconnect ${email} at ${origin}/accounts.`;
    case "blocked_by_admin":
      return `A Google Workspace admin blocked this server for ${email}. The owner can see the details at ${origin}/accounts.`;
    case "missing_access":
      return `Google did not grant all the Gmail access this server asks for on ${email}. Ask the owner to reconnect it at ${origin}/accounts and check every box.`;
    case "unreadable":
      return `The server cannot read its stored access to ${email}. Ask the owner to check ${origin}/accounts.`;
  }
};

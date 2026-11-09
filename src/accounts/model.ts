import { Data } from "effect";
export type AccountId = string & { readonly __accountId: unique symbol };
export type Health = "ready" | "needs_reconnect" | "blocked_by_admin";
export interface Credential {
  readonly id: AccountId;
  readonly email: string;
  readonly version: number;
  readonly health: Health;
  readonly blockedUntil: number | null;
  readonly refreshToken: string | null;
  readonly accessToken: string | null;
  readonly accessExpiresAt: number | null;
}
export class NeedsReconnect extends Data.TaggedError("NeedsReconnect")<{
  readonly email: string;
}> {}
export class BlockedByAdmin extends Data.TaggedError("BlockedByAdmin")<{
  readonly email: string;
}> {}
export class GoogleUnavailable extends Data.TaggedError("GoogleUnavailable") {}
export class AccountGone extends Data.TaggedError("AccountGone") {}
export class RequestLost extends Data.TaggedError("RequestLost") {}

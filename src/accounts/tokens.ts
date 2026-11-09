import { Effect } from "effect";
import type { Config } from "../config";
import type { Unavailable } from "../db";
import type { Owner } from "../owner/owner";
import {
  AccountGone,
  type Credential,
  type NeedsReconnect,
  type BlockedByAdmin,
  type GoogleUnavailable,
  type RequestLost,
} from "./model";
export const withGoogle = (
  _deps: { db: D1Database; config: Config; owner: Owner; now: () => number },
  _account: Credential,
  _build: (token: string) => Request,
): Effect.Effect<
  Response,
  NeedsReconnect | BlockedByAdmin | GoogleUnavailable | AccountGone | RequestLost | Unavailable
> => Effect.fail(new AccountGone());

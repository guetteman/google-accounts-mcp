import { Effect, Result } from "effect";
import type { Config } from "../config";
import { Unavailable } from "../db";
import type { Owner } from "../owner/owner";
import { open, seal } from "../seal";
import { refresh, GoogleUnavailable } from "../google/client";
import { AccountGone, BlockedByAdmin, NeedsReconnect, RequestLost, type Credential } from "./model";
import {
  claimBlockSlot,
  loadCredential,
  markBlocked,
  markNeedsReconnect,
  storeRefreshed,
} from "./store";
export type TokenError =
  | NeedsReconnect
  | BlockedByAdmin
  | GoogleUnavailable
  | AccountGone
  | RequestLost
  | Unavailable;
export type Deps = { db: D1Database; config: Config; owner: Owner; now: () => number };
interface Access {
  token: string;
  refreshed: boolean;
  snapshot: Credential;
  reloaded: boolean;
}

/**
 * The caller records the call and reads its allowed credential in one atomic D1 batch.
 * Every statement is guarded on the pinned owner's generation and address, an active
 * connection, and a live account with permission. A changed owner reads nothing.
 * Pass that owner in deps. A fresh token causes no D1 read here: the verified snapshot
 * is used as is, so permission changes take effect on the next call.
 *
 * build may run twice. Each call must create a fresh Request and body, with the caller's
 * cancellation signal. This function sets no deadline for the service request. After a refresh,
 * even a 401 is returned as the final Response; the caller must handle its status.
 *
 * NeedsReconnect means Google revoked access or stored ciphertext is damaged.
 * BlockedByAdmin means Google blocked the app. GoogleUnavailable covers token endpoint failures,
 * including refused OAuth clients. AccountGone means a reload found no live row. Unavailable
 * covers local failures: D1/crypto service failures or a second lost write race may be retried;
 * wrong keys, unsupported token formats and unreadable rows need configuration or data repair.
 * Do not retry Unavailable automatically without knowing its cause. RequestLost means fetch
 * rejected and the request may have taken effect; do not blindly resend. A throwing build is
 * a caller defect, not RequestLost.
 */
export const withGoogle = (
  deps: Deps,
  account: Credential,
  build: (accessToken: string) => Request,
): Effect.Effect<Response, TokenError> => {
  const acquire = (
    snapshot: Credential,
    force: boolean,
    reloaded: boolean,
  ): Effect.Effect<Access, TokenError> =>
    Effect.gen(function* () {
      const reload = (): Effect.Effect<Access, TokenError> =>
        Effect.gen(function* () {
          if (reloaded) return yield* Effect.fail(new Unavailable());
          const latest = yield* loadCredential(deps.db, deps.owner, snapshot.id);
          if (!latest) return yield* Effect.fail(new AccountGone());
          return yield* acquire(latest, false, true);
        });
      const damaged = (): Effect.Effect<Access, TokenError> =>
        Effect.gen(function* () {
          if (!(yield* markNeedsReconnect(deps.db, snapshot))) return yield* reload();
          return yield* Effect.fail(new NeedsReconnect({ email: snapshot.email }));
        });
      const decrypt = (context: string, value: import("../seal").Sealed) =>
        Effect.gen(function* () {
          const opened = yield* Effect.promise(() => open(deps.config.tokenKey, context, value));
          if (!opened.ok && opened.reason !== "damaged") {
            console.error(
              opened.reason === "other_key"
                ? "TOKEN_KEY does not match the stored tokens"
                : "Stored Google access could not be opened",
            );
            return yield* Effect.fail(new Unavailable());
          }
          return opened.ok ? opened.value : null;
        });
      if (snapshot.health === "needs_reconnect")
        return yield* Effect.fail(new NeedsReconnect({ email: snapshot.email }));
      if (snapshot.health === "blocked_by_admin") {
        if (snapshot.blockedUntil! > deps.now())
          return yield* Effect.fail(new BlockedByAdmin({ email: snapshot.email }));
      } else if (
        !force &&
        snapshot.accessToken &&
        snapshot.accessExpiresAt !== null &&
        snapshot.accessExpiresAt > deps.now() + 300000
      ) {
        const token = yield* decrypt(`${snapshot.id}:access`, snapshot.accessToken);
        return token === null ? yield* damaged() : { token, refreshed: false, snapshot, reloaded };
      }
      const refreshToken = snapshot.refreshToken
        ? yield* decrypt(`${snapshot.id}:refresh`, snapshot.refreshToken)
        : null;
      if (refreshToken === null) return yield* damaged();
      if (snapshot.health === "blocked_by_admin") {
        const claimedAt = deps.now();
        if (!(yield* claimBlockSlot(deps.db, snapshot, claimedAt))) return yield* reload();
        snapshot = { ...snapshot, blockedUntil: claimedAt + 600000 };
      }
      const result = yield* Effect.result(refresh(deps.config, refreshToken, deps.now()));
      if (Result.isFailure(result)) {
        if (result.failure._tag === "GoogleUnavailable") return yield* Effect.fail(result.failure);
        if (result.failure._tag === "ClientRefused")
          return yield* Effect.fail(new GoogleUnavailable());
        if (result.failure._tag === "GrantRevoked") return yield* damaged();
        if (!(yield* markBlocked(deps.db, snapshot, deps.now()))) return yield* reload();
        return yield* Effect.fail(new BlockedByAdmin({ email: snapshot.email }));
      }
      const sealed = yield* Effect.tryPromise({
        try: () => seal(deps.config.tokenKey, `${snapshot.id}:access`, result.success.accessToken),
        catch: () => new Unavailable(),
      });
      if (!(yield* storeRefreshed(deps.db, snapshot, sealed, result.success.expiresAt))) {
        const current = yield* reload();
        return { ...current, refreshed: true };
      }
      return { token: result.success.accessToken, refreshed: true, snapshot, reloaded };
    });
  const send = (token: string) => {
    const request = build(token);
    return Effect.tryPromise({ try: () => fetch(request), catch: () => new RequestLost() });
  };
  return Effect.gen(function* () {
    const access = yield* acquire(account, false, false);
    const response = yield* send(access.token);
    if (response.status !== 401 || access.refreshed) return response;
    const next = yield* acquire(access.snapshot, true, access.reloaded);
    return yield* send(next.token);
  });
};

import { Effect, Result } from "effect";
import type { Config } from "../config";
import type { Unavailable } from "../db";
import type { Owner } from "../owner/owner";
import { open, seal } from "../seal";
import { refresh } from "../google/client";
import {
  AccountGone,
  BlockedByAdmin,
  GoogleUnavailable,
  NeedsReconnect,
  RequestLost,
  type Credential,
} from "./model";
import {
  claimBlockSlot,
  loadCredential,
  markBlocked,
  markNeedsReconnect,
  storeRefreshed,
} from "./store";
type TokenError =
  | NeedsReconnect
  | BlockedByAdmin
  | GoogleUnavailable
  | AccountGone
  | RequestLost
  | Unavailable;
type Deps = { db: D1Database; config: Config; owner: Owner; now: () => number };
interface Access {
  token: string;
  refreshed: boolean;
}

/** The caller supplies its authorized snapshot; a fresh token needs no additional D1 read. */
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
          if (reloaded) return yield* Effect.fail(new AccountGone());
          const latest = yield* loadCredential(deps.db, deps.owner, snapshot.id);
          if (!latest) return yield* Effect.fail(new AccountGone());
          return yield* acquire(latest, false, true);
        });
      const damaged = (): Effect.Effect<Access, TokenError> =>
        Effect.gen(function* () {
          if (!(yield* markNeedsReconnect(deps.db, snapshot))) return yield* reload();
          return yield* Effect.fail(new NeedsReconnect({ email: snapshot.email }));
        });
      if (snapshot.health === "needs_reconnect")
        return yield* Effect.fail(new NeedsReconnect({ email: snapshot.email }));
      if (snapshot.health === "blocked_by_admin") {
        if (snapshot.blockedUntil === null || snapshot.blockedUntil > deps.now())
          return yield* Effect.fail(new BlockedByAdmin({ email: snapshot.email }));
        if (!(yield* claimBlockSlot(deps.db, snapshot, deps.now())))
          return yield* Effect.fail(new BlockedByAdmin({ email: snapshot.email }));
      } else if (
        !force &&
        snapshot.accessToken &&
        snapshot.accessExpiresAt !== null &&
        snapshot.accessExpiresAt > deps.now() + 300000
      ) {
        const token = yield* Effect.promise(() =>
          open(deps.config.tokenKey, `${snapshot.id}:access`, snapshot.accessToken!),
        );
        return token === null ? yield* damaged() : { token, refreshed: false };
      }
      const refreshToken = snapshot.refreshToken
        ? yield* Effect.promise(() =>
            open(deps.config.tokenKey, `${snapshot.id}:refresh`, snapshot.refreshToken!),
          )
        : null;
      if (refreshToken === null) return yield* damaged();
      const result = yield* Effect.result(refresh(deps.config, refreshToken, deps.now()));
      if (Result.isFailure(result)) {
        if (result.failure._tag === "GoogleUnavailable") return yield* Effect.fail(result.failure);
        if (result.failure._tag === "GrantRevoked") return yield* damaged();
        if (!(yield* markBlocked(deps.db, snapshot, deps.now()))) return yield* reload();
        return yield* Effect.fail(new BlockedByAdmin({ email: snapshot.email }));
      }
      const sealed = yield* Effect.tryPromise({
        try: () => seal(deps.config.tokenKey, `${snapshot.id}:access`, result.success.accessToken),
        catch: () => new GoogleUnavailable(),
      });
      if (!(yield* storeRefreshed(deps.db, snapshot, sealed, result.success.expiresAt))) {
        const current = yield* reload();
        return { ...current, refreshed: true };
      }
      return { token: result.success.accessToken, refreshed: true };
    });
  const send = (token: string) =>
    Effect.tryPromise({ try: () => fetch(build(token)), catch: () => new RequestLost() });
  return Effect.gen(function* () {
    const access = yield* acquire(account, false, false);
    const response = yield* send(access.token);
    if (response.status !== 401 || access.refreshed) return response;
    const next = yield* acquire(account, true, false);
    return yield* send(next.token);
  });
};

import { Data, Effect } from "effect";
import type { Config } from "../config";
import { first, run } from "../db";
import { hostCookie, readCookie } from "../http/cookies";
import { randomToken, sha256 } from "../lib/crypto";
import type { Generation } from "./owner";

const IDLE = 7 * 24 * 60 * 60 * 1000;
const ABSOLUTE = 30 * 24 * 60 * 60 * 1000;
const COOKIE_NAME = "__Host-session";
export type SessionToken = string & { readonly __sessionToken: unique symbol };
export interface OwnerSession {
  readonly generation: Generation;
  readonly tokenHash: string;
}
export class NotSignedIn extends Data.TaggedError("NotSignedIn") {}

export const newSession = () =>
  Effect.gen(function* () {
    const token = randomToken() as SessionToken;
    const tokenHash = yield* Effect.promise(() => hashToken(token));
    return { token, tokenHash };
  });

async function hashToken(value: string): Promise<string> {
  return [...new Uint8Array(await sha256(value))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function expiredSessionCleanup(db: D1Database, tokenHash: string, now: number) {
  return db
    .prepare(`DELETE FROM owner_sessions WHERE (last_used_at <= ? OR created_at <= ?)
    AND EXISTS (SELECT 1 FROM owner_sessions WHERE token_hash = ?)`)
    .bind(now - IDLE, now - ABSOLUTE, tokenHash);
}

export const requireOwner = (db: D1Database, config: Config, request: Request, now: number) =>
  Effect.gen(function* () {
    const token = readCookie(request, COOKIE_NAME);
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return yield* Effect.fail(new NotSignedIn());
    const tokenHash = yield* Effect.promise(() => hashToken(token));
    const row = yield* first<{ generation: Generation }>(
      db,
      `UPDATE owner_sessions SET last_used_at = ? WHERE token_hash = ?
       AND last_used_at > ? AND created_at > ?
       AND generation = (SELECT generation FROM owner WHERE id = 1 AND state = 'pinned' AND email = ?)
       RETURNING generation`,
      [now, tokenHash, now - IDLE, now - ABSOLUTE, config.ownerEmail],
    );
    if (!row) return yield* Effect.fail(new NotSignedIn());
    return { generation: row.generation, tokenHash } satisfies OwnerSession;
  });

export const signOut = (db: D1Database, session: OwnerSession) =>
  run(db, "DELETE FROM owner_sessions WHERE token_hash = ? AND generation = ?", [
    session.tokenHash,
    session.generation,
  ]).pipe(Effect.asVoid);

export const signOutEverywhere = (db: D1Database, session: OwnerSession) =>
  run(db, "DELETE FROM owner_sessions WHERE generation = ?", [session.generation]).pipe(
    Effect.asVoid,
  );

export const sessionCookie = (token: SessionToken | null) =>
  hostCookie(COOKIE_NAME, token ?? "", token ? ABSOLUTE / 1000 : 0);

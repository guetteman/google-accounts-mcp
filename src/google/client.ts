import { Data, Effect, Schema } from "effect";
import { decodeJwt } from "jose";
import type { Config } from "../config";
import { normalizeEmail } from "../owner/owner";

export const GMAIL_SCOPES = ["gmail.readonly", "gmail.compose", "gmail.send", "gmail.modify"]
  .map((scope) => `https://www.googleapis.com/auth/${scope}`)
  .concat("https://mail.google.com/");
export type GmailScopes = ReadonlyArray<string> & { readonly __gmailScopes: unique symbol };
export const parseGrantedScopes = (scope: unknown): GmailScopes =>
  GMAIL_SCOPES.filter(
    (s) => typeof scope === "string" && scope.split(/\s+/).includes(s),
  ) as unknown as GmailScopes;
export type GoogleAccountEmail = string & { readonly __googleAccountEmail: unique symbol };
export interface GoogleIdentity {
  readonly sub: string;
  readonly email: GoogleAccountEmail;
  readonly hd: string | null;
}
export interface Grant {
  readonly identity: GoogleIdentity;
  readonly scopes: ReadonlyArray<string>;
  readonly refreshToken: string;
  readonly accessToken: string;
  readonly expiresAt: number;
}
export class GoogleUnavailable extends Data.TaggedError("GoogleUnavailable") {}
export class ClientRefused extends Data.TaggedError("ClientRefused") {}
export class CodeRefused extends Data.TaggedError("CodeRefused") {}
export class NoRefreshToken extends Data.TaggedError("NoRefreshToken") {}
export class GrantRevoked extends Data.TaggedError("GrantRevoked") {}
export class AdminBlocked extends Data.TaggedError("AdminBlocked") {}
const TokenResponse = Schema.Struct({
  access_token: Schema.NonEmptyString,
  expires_in: Schema.Number.check(Schema.isGreaterThan(0)),
});
const object = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

export function authorizationUrl(
  config: Config,
  p: { origin: string; state: string; challenge: string; loginHint?: string },
): URL {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: config.google.clientId,
    redirect_uri: `${p.origin}/google/callback`,
    response_type: "code",
    scope: ["openid", "email", ...GMAIL_SCOPES].join(" "),
    access_type: "offline",
    prompt: p.loginHint ? "consent" : "consent select_account",
    state: p.state,
    code_challenge: p.challenge,
    code_challenge_method: "S256",
    ...(p.loginHint ? { login_hint: p.loginHint } : {}),
  }).toString();
  return url;
}
const tokenRequest = (config: Config, fields: Record<string, string>) =>
  Effect.tryPromise({
    try: async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      try {
        const response = await fetch("https://oauth2.googleapis.com/token", {
          method: "POST",
          redirect: "manual",
          signal: controller.signal,
          body: new URLSearchParams({
            client_id: config.google.clientId,
            client_secret: config.google.clientSecret,
            ...fields,
          }),
        });
        const body = object(await response.json());
        if (
          [
            "invalid_client",
            "deleted_client",
            "disabled_client",
            "unauthorized_client",
            "redirect_uri_mismatch",
            "invalid_request",
          ].includes(String(body.error))
        ) {
          console.error("Google OAuth client credentials were refused");
          throw new ClientRefused();
        }
        return { status: response.status, body };
      } finally {
        clearTimeout(timer);
      }
    },
    catch: (error) => (error instanceof ClientRefused ? error : new GoogleUnavailable()),
  });
const decodedToken = (body: unknown, now: number) =>
  Schema.decodeUnknownEffect(TokenResponse)(body).pipe(
    Effect.mapError(() => new GoogleUnavailable()),
    Effect.map((value) => ({
      accessToken: value.access_token,
      expiresAt: now + value.expires_in * 1000,
    })),
  );

export const exchangeCode = (
  config: Config,
  p: { origin: string; code: string; verifier: string; now: number },
) =>
  Effect.gen(function* () {
    const { status, body } = yield* tokenRequest(config, {
      grant_type: "authorization_code",
      code: p.code,
      code_verifier: p.verifier,
      redirect_uri: `${p.origin}/google/callback`,
    });
    if (status !== 200)
      return yield* Effect.fail(status === 400 ? new CodeRefused() : new GoogleUnavailable());
    let identity: GoogleIdentity | null = null;
    try {
      const claims = decodeJwt(String(body.id_token));
      const email = normalizeEmail(claims.email);
      if (
        typeof claims.sub === "string" &&
        claims.sub.length > 0 &&
        email &&
        claims.email_verified === true &&
        ["https://accounts.google.com", "accounts.google.com"].includes(String(claims.iss)) &&
        claims.aud === config.google.clientId &&
        typeof claims.exp === "number" &&
        claims.exp * 1000 > p.now
      )
        identity = {
          sub: claims.sub,
          email: String(email) as GoogleAccountEmail,
          hd: typeof claims.hd === "string" && claims.hd.length > 0 ? claims.hd : null,
        };
    } catch {
      /* Untrusted token endpoint payload; no claims leave this boundary. */
    }
    if (!identity) {
      console.error("Google OAuth identity was refused");
      return yield* Effect.fail(new ClientRefused());
    }
    if (typeof body.refresh_token !== "string" || !body.refresh_token)
      return yield* Effect.fail(new NoRefreshToken());
    const token = yield* decodedToken(body, p.now);
    return {
      identity,
      scopes:
        typeof body.scope === "string" ? [...new Set(body.scope.split(/\s+/).filter(Boolean))] : [],
      refreshToken: body.refresh_token,
      ...token,
    } satisfies Grant;
  });
export const refresh = (config: Config, refreshToken: string, now: number) =>
  Effect.gen(function* () {
    const { status, body } = yield* tokenRequest(config, {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });
    if (status === 400 && body.error === "invalid_grant")
      return yield* Effect.fail(new GrantRevoked());
    if (status === 400 && body.error === "admin_policy_enforced")
      return yield* Effect.fail(new AdminBlocked());
    if (status !== 200) return yield* Effect.fail(new GoogleUnavailable());
    return yield* decodedToken(body, now);
  });
export const revoke = (token: string): Effect.Effect<boolean> =>
  Effect.promise(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch("https://oauth2.googleapis.com/revoke", {
        method: "POST",
        redirect: "manual",
        signal: controller.signal,
        body: new URLSearchParams({ token }),
      });
      return response.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  });

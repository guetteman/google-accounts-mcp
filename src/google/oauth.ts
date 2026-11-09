import { Data, Effect, Result, Schema } from "effect";
import type { Config } from "../config";
import { base64url, decodeBase64url, sha256 } from "../lib/crypto";
import { normalizeEmail, NotOwner, type OwnerIdentity } from "../owner/owner";

export class GoogleRefused extends Data.TaggedError("GoogleRefused") {}
export class GoogleUnavailable extends Data.TaggedError("GoogleUnavailable") {}
export interface GoogleIdentity {
  readonly email: string;
  readonly emailVerified: true;
  readonly sub: string;
  readonly hd?: string;
}

export const ownerIdentity = (
  identity: GoogleIdentity,
  config: Config,
): Result.Result<OwnerIdentity, NotOwner> => {
  const email = normalizeEmail(identity.email);
  return email === config.ownerEmail
    ? Result.succeed({ email, googleSub: identity.sub })
    : Result.fail(new NotOwner({ email: identity.email }));
};

export const pkceChallenge = async (verifier: string) =>
  base64url(new Uint8Array(await sha256(verifier)));

export function authorizationUrl(p: {
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state: string;
  nonce: string;
  challenge: string;
  prompt: string;
  accessType?: "offline";
  includeGrantedScopes?: boolean;
}): URL {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: p.clientId,
    redirect_uri: p.redirectUri,
    response_type: "code",
    scope: p.scopes.join(" "),
    prompt: p.prompt,
    state: p.state,
    nonce: p.nonce,
    code_challenge: p.challenge,
    code_challenge_method: "S256",
    ...(p.accessType ? { access_type: p.accessType } : {}),
    ...(p.includeGrantedScopes !== undefined
      ? { include_granted_scopes: String(p.includeGrantedScopes) }
      : {}),
  }).toString();
  return url;
}

const Tokens = Schema.Struct({
  id_token: Schema.String,
  access_token: Schema.String,
  refresh_token: Schema.optionalKey(Schema.String),
  scope: Schema.String,
  expires_in: Schema.Number,
});

export const exchangeCode = (config: Config, code: string, verifier: string, redirectUri: string) =>
  Effect.gen(function* () {
    const { response, body } = yield* Effect.tryPromise({
      try: async () => {
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          // Race explicitly: an intercepted or stalled fetch may never reject after aborting.
          return await Promise.race([
            fetch("https://oauth2.googleapis.com/token", {
              method: "POST",
              signal: controller.signal,
              body: new URLSearchParams({
                grant_type: "authorization_code",
                code,
                client_id: config.google.clientId,
                client_secret: config.google.clientSecret,
                redirect_uri: redirectUri,
                code_verifier: verifier,
              }),
            }).then(async (response) => ({
              response,
              body: response.ok ? await response.json() : undefined,
            })),
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => {
                reject(new Error("Google timeout"));
                controller.abort();
              }, 10_000);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      },
      catch: () => new GoogleUnavailable(),
    });
    if (response.status === 429 || response.status >= 500)
      return yield* Effect.fail(new GoogleUnavailable());
    if (!response.ok) return yield* Effect.fail(new GoogleRefused());
    const tokens = yield* Schema.decodeUnknownEffect(Tokens)(body).pipe(
      Effect.mapError(() => new GoogleUnavailable()),
    );
    return {
      idToken: tokens.id_token,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      scope: tokens.scope,
      expiresIn: tokens.expires_in,
    };
  });

const Claims = Schema.Struct({
  iss: Schema.Literals(["https://accounts.google.com", "accounts.google.com"]),
  aud: Schema.String,
  exp: Schema.Number,
  nonce: Schema.String,
  sub: Schema.String.check(Schema.isMinLength(1)),
  email: Schema.String.check(Schema.isMinLength(1)),
  email_verified: Schema.Literal(true),
  hd: Schema.optionalKey(Schema.String),
});

export function checkIdToken(
  raw: string,
  expect: { clientId: string; nonce: string; now: number },
): Result.Result<GoogleIdentity, { rejected: true; email?: string }> {
  let email: string | undefined;
  try {
    const segments = raw.split(".");
    if (segments.length !== 3 || !segments[1]) return Result.fail({ rejected: true });
    const payload: unknown = JSON.parse(decodeBase64url(segments[1]));
    if (
      payload &&
      typeof payload === "object" &&
      "email" in payload &&
      typeof payload.email === "string"
    )
      email = payload.email.toLowerCase();
    const result = Schema.decodeUnknownResult(Claims)(payload);
    if (Result.isSuccess(result)) {
      const claims = result.success;
      if (
        claims.aud === expect.clientId &&
        claims.nonce === expect.nonce &&
        claims.exp > expect.now / 1000
      ) {
        return Result.succeed({
          email: claims.email.toLowerCase(),
          emailVerified: true,
          sub: claims.sub,
          ...(claims.hd ? { hd: claims.hd } : {}),
        });
      }
    }
  } catch {
    /* Malformed token claims are an identity refusal. */
  }
  return Result.fail({ rejected: true, ...(email ? { email } : {}) });
}

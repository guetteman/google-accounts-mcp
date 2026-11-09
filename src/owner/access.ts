import { Data, Effect } from "effect";
import { createLocalJWKSet, errors, jwtVerify } from "jose";
import type { Config } from "../config";
import { normalizeEmail } from "./owner";

export class AccessMissing extends Data.TaggedError("AccessMissing") {}
export class AccessRejected extends Data.TaggedError("AccessRejected") {}
export class AccessUnavailable extends Data.TaggedError("AccessUnavailable") {}
export interface AccessIdentity {
  readonly email: string;
}

const CERTS_TIMEOUT = 5_000;
const CACHE_MAX_AGE = 10 * 60_000;
type Keys = ReturnType<typeof createLocalJWKSet>;
let cached: { issuer: string; keys: Keys; fetchedAt: number } | undefined;

async function fetchKeys(issuer: string): Promise<Keys> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CERTS_TIMEOUT);
  try {
    const response = await fetch(`${issuer}/cdn-cgi/access/certs`, {
      signal: controller.signal,
      redirect: "manual",
    });
    if (!response.ok) throw new AccessUnavailable();
    const keys = createLocalJWKSet(await response.json());
    cached = { issuer, keys, fetchedAt: Date.now() };
    return keys;
  } catch {
    // Fetch errors can contain configured values. Keep them inside this boundary.
    throw new AccessUnavailable();
  } finally {
    clearTimeout(timeout);
  }
}

export const verifyAccess = (request: Request, access: Config["access"], now: number) =>
  Effect.tryPromise({
    try: async (): Promise<AccessIdentity> => {
      const assertion = request.headers.get("Cf-Access-Jwt-Assertion");
      if (!assertion) throw new AccessMissing();
      const { payload } = await jwtVerify(
        assertion,
        async (header, token) => {
          if (typeof header.kid !== "string" || !header.kid) throw new AccessRejected();
          let keys =
            cached?.issuer === access.issuer && now < cached.fetchedAt + CACHE_MAX_AGE
              ? cached.keys
              : await fetchKeys(access.issuer);
          try {
            return await keys(header, token);
          } catch (error) {
            if (!(error instanceof errors.JWKSNoMatchingKey)) throw new AccessUnavailable();
          }
          // A new kid can mean rotation. Refresh once even when the cache is still fresh.
          keys = await fetchKeys(access.issuer);
          try {
            return await keys(header, token);
          } catch (error) {
            if (error instanceof errors.JWKSNoMatchingKey) throw new AccessRejected();
            throw new AccessUnavailable();
          }
        },
        {
          algorithms: ["RS256"],
          issuer: access.issuer,
          audience: access.audience,
          requiredClaims: ["exp", "nbf", "email"],
          currentDate: new Date(now),
        },
      );
      const email = normalizeEmail(payload.email);
      if (!email) throw new AccessRejected();
      return { email };
    },
    catch: (error) =>
      error instanceof AccessMissing || error instanceof AccessUnavailable
        ? error
        : new AccessRejected(),
  });

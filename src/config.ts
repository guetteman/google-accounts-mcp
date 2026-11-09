import { Data, Result } from "effect";
import { normalizeEmail, type OwnerEmail } from "./owner/owner";

export type ConfigName =
  | "OWNER_EMAIL"
  | "ACCESS_ISSUER"
  | "ACCESS_AUDIENCE"
  | "GOOGLE_CLIENT_ID"
  | "GOOGLE_CLIENT_SECRET"
  | "TOKEN_KEY";
export class Incomplete extends Data.TaggedError("Incomplete")<{
  readonly names: ConfigName[];
}> {}
export type AccessIssuer = string & { readonly __accessIssuer: unique symbol };
export type TokenKey = Uint8Array<ArrayBuffer> & { readonly __tokenKey: unique symbol };
export interface Config {
  readonly google: { readonly clientId: string; readonly clientSecret: string };
  readonly tokenKey: TokenKey;
  readonly ownerEmail: OwnerEmail;
  readonly access: { readonly issuer: AccessIssuer; readonly audience: string };
}

export function readConfig(env: Env): Result.Result<Config, Incomplete> {
  const ownerEmail = normalizeEmail(env.OWNER_EMAIL);
  // Compare the issuer exactly: trimming or URL normalization could hide a setup mistake.
  const issuer = env.ACCESS_ISSUER;
  const validIssuer =
    typeof issuer === "string" &&
    /^https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.cloudflareaccess\.com$/.test(issuer);
  const audience = env.ACCESS_AUDIENCE;
  const validAudience = typeof audience === "string" && /^[a-fA-F0-9]{64}$/.test(audience);
  const clientId = env.GOOGLE_CLIENT_ID;
  const validClient =
    typeof clientId === "string" && /^[a-zA-Z0-9_-]+\.apps\.googleusercontent\.com$/.test(clientId);
  const clientSecret = env.GOOGLE_CLIENT_SECRET;
  const validSecret = typeof clientSecret === "string" && clientSecret.trim().length > 0;
  const tokenKey = env.TOKEN_KEY;
  const validKey = typeof tokenKey === "string" && /^[a-fA-F0-9]{64}$/.test(tokenKey);
  const names: ConfigName[] = [];
  if (!ownerEmail) names.push("OWNER_EMAIL");
  if (!validIssuer) names.push("ACCESS_ISSUER");
  if (!validAudience) names.push("ACCESS_AUDIENCE");
  if (!validClient) names.push("GOOGLE_CLIENT_ID");
  if (!validSecret) names.push("GOOGLE_CLIENT_SECRET");
  if (!validKey) names.push("TOKEN_KEY");
  if (!ownerEmail || !validIssuer || !validAudience || !validClient || !validSecret || !validKey)
    return Result.fail(new Incomplete({ names }));
  return Result.succeed({
    ownerEmail,
    access: { issuer: issuer as AccessIssuer, audience },
    google: { clientId, clientSecret },
    tokenKey: Uint8Array.from(tokenKey.match(/../g)!, (byte) => parseInt(byte, 16)) as TokenKey,
  });
}

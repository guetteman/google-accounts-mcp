import { Data, Result } from "effect";
import { normalizeEmail, type OwnerEmail } from "./owner/owner";

export type ConfigName = "OWNER_EMAIL" | "ACCESS_ISSUER" | "ACCESS_AUDIENCE";
export class Incomplete extends Data.TaggedError("Incomplete")<{
  readonly names: ConfigName[];
}> {}
export type AccessIssuer = string & { readonly __accessIssuer: unique symbol };
export interface Config {
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
  const names: ConfigName[] = [];
  if (!ownerEmail) names.push("OWNER_EMAIL");
  if (!validIssuer) names.push("ACCESS_ISSUER");
  if (!validAudience) names.push("ACCESS_AUDIENCE");
  if (!ownerEmail || !validIssuer || !validAudience) return Result.fail(new Incomplete({ names }));
  return Result.succeed({ ownerEmail, access: { issuer: issuer as AccessIssuer, audience } });
}

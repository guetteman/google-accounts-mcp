import { Data, Result } from "effect";
import { normalizeEmail, type OwnerEmail } from "./owner/owner";

export type ConfigName = "OWNER_EMAIL" | "GOOGLE_CLIENT_ID" | "GOOGLE_CLIENT_SECRET";
export class Incomplete extends Data.TaggedError("Incomplete")<{
  readonly names: ConfigName[];
}> {}

export interface Config {
  readonly ownerEmail: OwnerEmail;
  readonly google: { readonly clientId: string; readonly clientSecret: string };
}

export function readConfig(env: Env): Result.Result<Config, Incomplete> {
  const ownerEmail = normalizeEmail(env.OWNER_EMAIL);
  const clientId = env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim();
  const names: ConfigName[] = [];
  if (!ownerEmail) names.push("OWNER_EMAIL");
  if (!clientId) names.push("GOOGLE_CLIENT_ID");
  if (!clientSecret) names.push("GOOGLE_CLIENT_SECRET");
  if (!ownerEmail || !clientId || !clientSecret) return Result.fail(new Incomplete({ names }));
  return Result.succeed({ ownerEmail, google: { clientId, clientSecret } });
}

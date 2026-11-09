import type { Config } from "../config";
import type { OAuthEnv } from "../oauth/server";
import type { Owner } from "../owner/owner";

export interface PageEnv {
  Bindings: OAuthEnv;
  Variables: { config: Config; owner: Owner; form: FormData };
}

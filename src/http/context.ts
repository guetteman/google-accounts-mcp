import type { Config } from "../config";
import type { OwnerSession } from "../owner/session";

export interface PageEnv {
  Bindings: Env;
  Variables: { config: Config; owner: OwnerSession };
}

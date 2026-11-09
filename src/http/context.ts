import type { Config } from "../config";
import type { Owner } from "../owner/owner";

export interface PageEnv {
  Bindings: Env;
  Variables: { config: Config; owner: Owner };
}

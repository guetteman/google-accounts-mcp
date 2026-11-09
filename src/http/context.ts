import type { Config } from "../config";
import type { GatedEnv } from "../owner/gate";
import type { Owner } from "../owner/owner";

export interface PageEnv {
  Bindings: GatedEnv;
  Variables: { config: Config; owner: Owner };
}

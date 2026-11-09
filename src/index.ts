import { withOwnerGate } from "./owner/gate";
import { oauthServer } from "./oauth/server";
import { withClientFilter } from "./oauth/clients";

export default {
  fetch: withOwnerGate(withClientFilter(oauthServer.fetch)),
} satisfies ExportedHandler<Env>;

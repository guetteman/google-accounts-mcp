import { withUploadLink } from "./uploads/link";
import { scheduled } from "./approvals/scheduled";
import { withOwnerGate } from "./owner/gate";
import { oauthServer } from "./oauth/server";
import { withClientFilter } from "./oauth/clients";

export default {
  scheduled,
  fetch: withOwnerGate(withUploadLink(withClientFilter(oauthServer.fetch))),
} satisfies ExportedHandler<Env>;

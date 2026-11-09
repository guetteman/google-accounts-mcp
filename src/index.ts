import { withOwnerGate } from "./owner/gate";
import { app } from "./http/app";

export default {
  fetch: withOwnerGate(app.fetch),
} satisfies ExportedHandler<Env>;

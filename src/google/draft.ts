import { Effect, Schema } from "effect";
import type { Send } from "../mcp/tools";
import { ToolFailure } from "../mcp/failures";
import type { Created } from "../once/store";
import { change } from "./gmail";

const Draft = Schema.Struct({
  id: Schema.String,
  message: Schema.Struct({ id: Schema.String, threadId: Schema.String }),
});
export const createDraft = (
  send: Send,
  input: { raw: string; thread?: string },
): Effect.Effect<Created, ToolFailure> =>
  change(send, "POST", "drafts", Draft, () => new ToolFailure({ code: "google_unavailable" }), {
    message: { raw: input.raw, ...(input.thread === undefined ? {} : { threadId: input.thread }) },
  }).pipe(
    Effect.map((draft) => ({
      draft: draft.id,
      message: draft.message.id,
      thread: draft.message.threadId,
    })),
  );

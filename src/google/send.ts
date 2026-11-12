import { Effect, Schema } from "effect";
import { creating, notFound, notSendable, ToolFailure } from "../mcp/failures";
import type { Confirm, Send, Sending } from "../mcp/tools";
import type { Created } from "../once/store";
import { readDraft } from "./draft";
import { change } from "./gmail";

const Sent = Schema.Struct({ id: Schema.String, threadId: Schema.String });
const unavailable = () => new ToolFailure({ code: "google_unavailable" });
/** The only request that makes mail leave. The check supplies its request function here. */
const sendOne = (
  confirm: Confirm,
  draft: string,
  refused: (status: number) => ToolFailure,
): Effect.Effect<Created, ToolFailure> =>
  Effect.gen(function* () {
    const sending = yield* confirm;
    const sent = yield* creating(
      change(sending, "POST", "drafts/send", Sent, refused, { id: draft }),
    );
    return { message: sent.id, thread: sent.threadId };
  });

export const sendStaged = (
  send: Send,
  confirm: Confirm,
  stage: Effect.Effect<Created, ToolFailure>,
): Effect.Effect<Created, ToolFailure> =>
  Effect.gen(function* () {
    const staged = yield* stage;
    if (!staged.draft) throw new Error("A staged draft must have an ID");
    let sending: Sending | undefined;
    const checked = confirm.pipe(
      Effect.tap((value) =>
        Effect.sync(() => {
          sending = value;
        }),
      ),
    );
    return yield* sendOne(checked, staged.draft, (status) =>
      status === 400
        ? notSendable(null)
        : status === 404
          ? new ToolFailure({ code: "outcome_unknown", unknown: true })
          : unavailable(),
    ).pipe(
      Effect.catch((failure) =>
        Effect.gen(function* () {
          if (failure.code !== "outcome_unknown")
            yield* change(
              sending ?? send,
              "DELETE",
              `drafts/${staged.draft}`,
              null,
              unavailable,
            ).pipe(Effect.ignore);
          return yield* Effect.fail(failure);
        }),
      ),
    );
  });

export const sendExisting = (
  confirm: Confirm,
  draft: string,
): Effect.Effect<Created, ToolFailure> =>
  Effect.gen(function* () {
    let sending: Sending | undefined;
    let badRequest = false;
    const checked = confirm.pipe(
      Effect.tap((value) =>
        Effect.sync(() => {
          sending = value;
        }),
      ),
    );
    return yield* sendOne(checked, draft, (status) => {
      if (status === 400) {
        badRequest = true;
        return notSendable(draft);
      }
      return status === 404 ? notFound("draft", draft) : unavailable();
    }).pipe(
      Effect.catch((failure) =>
        Effect.gen(function* () {
          if (badRequest && sending) yield* readDraft(sending, draft);
          return yield* Effect.fail(failure);
        }),
      ),
    );
  });

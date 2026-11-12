import { Effect, Result, Schema } from "effect";
import { creating, messageTooLarge, notFound, notSendable, ToolFailure } from "../mcp/failures";
import type { Confirm } from "../mcp/tools";
import type { Created } from "../once/store";
import type { CreatedDraft } from "./draft";
import { change, get } from "./gmail";

const Sent = Schema.Struct({ id: Schema.String, threadId: Schema.String });
const unavailable = () => new ToolFailure({ code: "google_unavailable" });
/** The only request that makes mail leave. The check supplies its request function here. */
const sendOne = (
  confirm: Confirm,
  draft: string,
  refused: (status: number) => ToolFailure,
): Effect.Effect<Created, ToolFailure> =>
  Effect.gen(function* () {
    const sending = yield* confirm.check;
    const sent = yield* creating(
      change(
        sending,
        "POST",
        "drafts/send",
        Sent,
        (status) => (status === 413 ? messageTooLarge(null) : refused(status)),
        { id: draft },
      ),
    );
    return { message: sent.id, thread: sent.threadId };
  });

export const sendStaged = (
  confirm: Confirm,
  stage: Effect.Effect<CreatedDraft, ToolFailure>,
): Effect.Effect<Created, ToolFailure> =>
  Effect.gen(function* () {
    const staged = yield* stage.pipe(
      Effect.mapError((failure) => {
        if (!failure.unknown) return failure;
        const data: ConstructorParameters<typeof ToolFailure>[0] = failure;
        return new ToolFailure({ ...data, leftover: true });
      }),
    );
    return yield* sendOne(confirm, staged.draft, (status) =>
      status === 400
        ? notSendable(null)
        : status === 404
          ? new ToolFailure({ code: "outcome_unknown", unknown: true })
          : unavailable(),
    ).pipe(
      Effect.catch((failure) =>
        Effect.gen(function* () {
          if (failure.code !== "outcome_unknown") {
            const cleanup = yield* Effect.result(
              change(confirm.late, "DELETE", `drafts/${staged.draft}`, null, (status) =>
                status === 404 ? notFound("draft", staged.draft) : unavailable(),
              ).pipe(
                Effect.catch((failure) =>
                  failure.code === "not_found" ? Effect.void : Effect.fail(failure),
                ),
              ),
            );
            if (Result.isFailure(cleanup)) {
              const data: ConstructorParameters<typeof ToolFailure>[0] = failure;
              return yield* Effect.fail(new ToolFailure({ ...data, leftover: true }));
            }
          }
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
    yield* get(
      confirm.late,
      `drafts/${draft}?format=minimal`,
      Schema.Struct({ id: Schema.String }),
      (status) => (status === 404 || status === 400 ? notFound("draft", draft) : unavailable()),
    );
    return yield* sendOne(confirm, draft, (status) =>
      status === 400
        ? notSendable(draft)
        : status === 404
          ? notFound("draft", draft)
          : unavailable(),
    );
  });

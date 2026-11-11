import { Effect, Schema } from "effect";
import type { Send } from "../mcp/tools";
import { ToolFailure } from "../mcp/failures";
const Labels = Schema.Struct({
  labels: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        name: Schema.String,
        type: Schema.Literals(["system", "user"]),
      }),
    ),
  ),
});
export const listLabels = (send: Send) =>
  Effect.gen(function* () {
    const response = yield* send(
      (token, signal) =>
        new Request("https://gmail.googleapis.com/gmail/v1/users/me/labels", {
          headers: { Authorization: `Bearer ${token}` },
          redirect: "manual",
          signal,
        }),
    );
    if (!response.ok) return yield* Effect.fail(new ToolFailure({ code: "google_unavailable" }));
    const text = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: () => new ToolFailure({ code: "google_unavailable", unknown: true }),
    });
    const body = yield* Effect.try({
      try: (): unknown => JSON.parse(text),
      catch: () => new ToolFailure({ code: "google_unavailable" }),
    });
    const parsed = yield* Schema.decodeUnknownEffect(Labels)(body).pipe(
      Effect.mapError(() => new ToolFailure({ code: "google_unavailable" })),
    );
    return parsed.labels ?? [];
  });

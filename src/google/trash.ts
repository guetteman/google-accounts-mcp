import { Effect, Schema } from "effect";
import { viewDate, type ViewValue } from "../approvals/model";
import { notFound, ToolFailure } from "../mcp/failures";
import type { Send } from "../mcp/tools";
import { change, changeEach, messageSummary, REQUESTS_AT_ONCE } from "./gmail";

type Input = { account: string; messages: readonly string[] };
type Changes<A> = {
  account: string;
  messages: A[];
  not_found?: string[];
  unconfirmed?: string[];
};
const Message = Schema.Struct({
  id: Schema.String,
  labelIds: Schema.optionalKey(Schema.Array(Schema.String)),
});
const refused = (id: string) => (status: number) =>
  status === 404 || status === 400
    ? notFound("message", id)
    : new ToolFailure({ code: "google_unavailable" });
const result = <A>(
  account: string,
  changes: { changed: A[]; not_found: string[]; unconfirmed: string[] },
): Changes<A> => ({
  account,
  messages: changes.changed,
  ...(changes.not_found.length ? { not_found: changes.not_found } : {}),
  ...(changes.unconfirmed.length ? { unconfirmed: changes.unconfirmed } : {}),
});
const move = (send: Send, input: Input, action: "trash" | "untrash") =>
  changeEach("message", input.messages, (id) =>
    change(send, "POST", `messages/${encodeURIComponent(id)}/${action}`, Message, refused(id)).pipe(
      Effect.map((message) => ({ message: id, labels: message.labelIds ?? [] })),
    ),
  ).pipe(Effect.map((changes) => result(input.account, changes)));

export const trashMessages = (send: Send, input: Input) => move(send, input, "trash");
export const restoreMessages = (send: Send, input: Input) => move(send, input, "untrash");
export const deleteMessages = (send: Send, input: Input) =>
  changeEach("message", input.messages, (id) =>
    change(send, "DELETE", `messages/${encodeURIComponent(id)}`, null, refused(id)).pipe(
      Effect.map(() => id),
    ),
  ).pipe(Effect.map((changes) => result(input.account, changes)));

/** The first metadata read goes alone; later reads run at most five at a time, in input order. */
export const messageValues = (
  send: Send,
  messages: readonly string[],
): Effect.Effect<ReadonlyArray<ViewValue>, ToolFailure> =>
  Effect.gen(function* () {
    const one = (id: string, index: number): Effect.Effect<ViewValue[], ToolFailure> => {
      const prefix = messages.length === 1 ? "" : `Message ${index + 1} `;
      return messageSummary(send, id).pipe(
        Effect.map((summary): ViewValue[] => [
          { name: prefix ? `${prefix}from` : "From", text: summary.from, from: "gmail" },
          { name: prefix ? `${prefix}subject` : "Subject", text: summary.subject, from: "gmail" },
          { name: prefix ? `${prefix}date` : "Date", text: viewDate(summary.date), from: "gmail" },
        ]),
        Effect.catch((error) =>
          error.code === "not_found"
            ? Effect.succeed<ViewValue[]>([
                {
                  name: `${prefix || "Message "}ID, not found in this account`,
                  text: id,
                  from: "agent",
                },
              ])
            : Effect.fail(error),
        ),
      );
    };
    const first = yield* Effect.forEach(messages.slice(0, 1), (id) => one(id, 0));
    const rest = yield* Effect.forEach(messages.slice(1), (id, index) => one(id, index + 1), {
      concurrency: REQUESTS_AT_ONCE,
    });
    return [...first, ...rest].flat();
  });

import { Effect, Schema } from "effect";
import type { Send } from "../mcp/tools";
import { ToolFailure } from "../mcp/failures";
import { isoSeconds } from "../approvals/model";

const API = "https://gmail.googleapis.com/gmail/v1/users/me";
const unavailable = () => new ToolFailure({ code: "google_unavailable" });
/** One GET as the account. Any status outside 200 to 299 goes to refused, with its status. */
const get = <A>(
  send: Send,
  path: string,
  schema: Schema.Codec<A, unknown>,
  refused: (status: number) => ToolFailure = unavailable,
) =>
  Effect.gen(function* () {
    const response = yield* send(
      (token, signal) =>
        new Request(`${API}/${path}`, {
          headers: { Authorization: `Bearer ${token}` },
          redirect: "manual",
          signal,
        }),
    );
    if (!response.ok) return yield* Effect.fail(refused(response.status));
    const text = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: () => new ToolFailure({ code: "google_unavailable", unknown: true }),
    });
    const body = yield* Effect.try({
      try: (): unknown => JSON.parse(text),
      catch: unavailable,
    });
    return yield* Schema.decodeUnknownEffect(schema)(body).pipe(Effect.mapError(unavailable));
  });

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
  get(send, "labels", Labels).pipe(Effect.map((parsed) => parsed.labels ?? []));

// Shapes observed on a real account on 2026-11-11 (issue #23). A list with no result has
// no threads key. A thread's messages come oldest first, and internalDate is milliseconds.
const ThreadList = Schema.Struct({
  threads: Schema.optionalKey(
    Schema.Array(Schema.Struct({ id: Schema.String, snippet: Schema.String })),
  ),
  nextPageToken: Schema.optionalKey(Schema.String),
});
const Thread = Schema.Struct({
  messages: Schema.NonEmptyArray(
    Schema.Struct({
      labelIds: Schema.optionalKey(Schema.Array(Schema.String)),
      internalDate: Schema.String,
      payload: Schema.optionalKey(
        Schema.Struct({
          headers: Schema.optionalKey(
            Schema.Array(Schema.Struct({ name: Schema.String, value: Schema.String })),
          ),
        }),
      ),
    }),
  ),
});
// Gmail escapes a snippet as HTML. The agent gets the text.
const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};
const decodeEntities = (text: string) =>
  text.replace(/&(?:#(\d+)|#x([0-9a-fA-F]+)|([a-z]+));/g, (whole, decimal, hex, name) => {
    const code = decimal ? Number(decimal) : hex ? parseInt(hex, 16) : null;
    if (code === null) return ENTITIES[name as string] ?? whole;
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
const header = (message: (typeof Thread.Type)["messages"][number], name: string): string =>
  message.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
/** Cloudflare allows a Worker six connections at once for one request; five leave one free. */
const THREADS_AT_ONCE = 5;
export const searchThreads = (
  send: Send,
  input: { query: string; limit: number; page: string | undefined },
) =>
  Effect.gen(function* () {
    const params = new URLSearchParams({ q: input.query, maxResults: String(input.limit) });
    if (input.page !== undefined) params.set("pageToken", input.page);
    // This request goes alone, so an expired token is refreshed once before the threads.
    const list = yield* get(send, `threads?${params}`, ThreadList, (status) =>
      status === 400 && input.page !== undefined
        ? new ToolFailure({
            code: "invalid_arguments",
            field: { name: "page", expects: "the next_page value of an earlier result" },
          })
        : unavailable(),
    );
    const threads = yield* Effect.forEach(
      list.threads ?? [],
      (listed) =>
        get(
          send,
          `threads/${encodeURIComponent(listed.id)}?format=metadata&metadataHeaders=Subject&metadataHeaders=From`,
          Thread,
        ).pipe(
          Effect.flatMap((thread) => {
            const first = thread.messages[0];
            const last = thread.messages[thread.messages.length - 1]!;
            const at = Number(last.internalDate);
            // A Date holds at most 8.64e15 milliseconds.
            if (!Number.isSafeInteger(at) || Math.abs(at) > 8.64e15)
              return Effect.fail(unavailable());
            return Effect.succeed({
              thread: listed.id,
              subject: header(first, "Subject"),
              from: header(last, "From"),
              date: isoSeconds(at),
              snippet: decodeEntities(listed.snippet),
              messages: thread.messages.length,
              unread: thread.messages.some((m) => m.labelIds?.includes("UNREAD") === true),
            });
          }),
        ),
      { concurrency: THREADS_AT_ONCE },
    );
    return {
      threads,
      ...(list.nextPageToken === undefined ? {} : { next_page: list.nextPageToken }),
    };
  });

import { Effect, Result, Schema } from "effect";
import type { Send } from "../mcp/tools";
import { notFound, ToolFailure, type Missing } from "../mcp/failures";
import { isoSeconds } from "../approvals/model";
import { decodeEntities } from "./html";
import { Headers, InternalDate, header } from "./message";
import { shorten } from "./bounds";

const API = "https://gmail.googleapis.com/gmail/v1/users/me";
const unavailable = () => new ToolFailure({ code: "google_unavailable" });
/** Gmail answers 404 or 400 for an ID the account does not have; any other refusal is unavailable. */
export const notFoundOr = (kind: Missing, id: string) => (status: number) =>
  status === 404 || status === 400 ? notFound(kind, id) : unavailable();
/** One GET as the account. Any status outside 200 to 299 goes to refused, with its status. */
export const get = <A>(
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

/**
 * A thread, message, or draft ID as a tool accepts it: 1 to 64 URL-safe characters. Effect
 * publishes a pattern in the tool's JSON Schema only for a regular expression with the u flag.
 */
export const GmailId = Schema.String.check(
  Schema.isBetweenLength(1, 64),
  Schema.isPattern(/^[A-Za-z0-9_-]+$/u),
);

/** Shared answer shape for attachments.get, including read_thread's deferred body parts. */
export const AttachmentBytes = Schema.Struct({ data: Schema.String });

/** One change as the account. Only a 4xx response confirms that Google refused it. */
export const change = <A>(
  send: Send,
  method: "POST" | "DELETE",
  path: string,
  schema: Schema.Codec<A, unknown> | null,
  refused: (status: number) => ToolFailure,
  body?: unknown,
): Effect.Effect<A, ToolFailure> =>
  Effect.gen(function* () {
    const response = yield* send(
      (token, signal) =>
        new Request(`${API}/${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          redirect: "manual",
          signal,
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
    );
    return yield* changed(response, schema, refused);
  });

/** A byte upload uses the same refusal and uncertainty rules as a JSON change. */
export const upload = <A>(
  send: Send,
  path: string,
  schema: Schema.Codec<A, unknown>,
  refused: (status: number) => ToolFailure,
  body: Blob,
  contentType: string,
): Effect.Effect<A, ToolFailure> =>
  Effect.gen(function* () {
    const response = yield* send(
      (token, signal) =>
        new Request(`https://gmail.googleapis.com/upload/gmail/v1/users/me/${path}`, {
          method: "POST",
          redirect: "manual",
          signal,
          body,
          headers: { Authorization: `Bearer ${token}`, "Content-Type": contentType },
        }),
    );
    return yield* changed(response, schema, refused);
  });

const changed = <A>(
  response: Response,
  schema: Schema.Codec<A, unknown> | null,
  refused: (status: number) => ToolFailure,
): Effect.Effect<A, ToolFailure> =>
  Effect.gen(function* () {
    const uncertain = () => new ToolFailure({ code: "google_unavailable", unknown: true });
    if (response.status >= 400 && response.status < 500)
      return yield* Effect.fail(refused(response.status));
    if (!response.ok) return yield* Effect.fail(uncertain());
    if (schema === null) return undefined as A;
    const text = yield* Effect.tryPromise({ try: () => response.text(), catch: uncertain });
    const parsed = yield* Effect.try({ try: (): unknown => JSON.parse(text), catch: uncertain });
    return yield* Schema.decodeUnknownEffect(schema)(parsed).pipe(Effect.mapError(uncertain));
  });

/**
 * The most threads or messages that one call which changes mail may name. Approving a call of
 * 15 makes about 34 requests to Google and Cloudflare Access (rebuilding the view, running,
 * one token refresh, Access's keys on a cold Worker) plus about 8 D1 queries: about 42, inside
 * the 50 subrequests of the Workers Free plan however D1 is counted.
 */
export const MAX_ITEMS = 15;

/**
 * Send the first item alone so a session without a token acquires it once, and a failure other
 * than not_found stops the call after one request. Keep every item's outcome.
 */
export const changeEach = <A>(
  kind: Missing,
  ids: readonly string[],
  one: (id: string) => Effect.Effect<A, ToolFailure>,
): Effect.Effect<{ changed: A[]; not_found: string[]; unconfirmed: string[] }, ToolFailure> =>
  Effect.gen(function* () {
    const attempt = (id: string) =>
      Effect.result(one(id)).pipe(Effect.map((result) => ({ id, result })));
    const first = yield* Effect.forEach(ids.slice(0, 1), attempt);
    const initial = first[0]?.result;
    if (initial && Result.isFailure(initial) && initial.failure.code !== "not_found")
      return yield* Effect.fail(initial.failure);
    const rest = yield* Effect.forEach(ids.slice(1), attempt, { concurrency: REQUESTS_AT_ONCE });
    const changed: A[] = [];
    const not_found: string[] = [];
    const unconfirmed: string[] = [];
    const failures: ToolFailure[] = [];
    for (const { id, result } of [...first, ...rest]) {
      if (Result.isSuccess(result)) changed.push(result.success);
      else if (result.failure.code === "not_found") not_found.push(id);
      else {
        unconfirmed.push(id);
        failures.push(result.failure);
      }
    }
    if (changed.length > 0) return { changed, not_found, unconfirmed };
    const failure = failures.find((failure) => failure.unknown) ?? failures[0];
    return yield* Effect.fail(failure ?? notFound(kind, ids));
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
      id: Schema.String,
      labelIds: Schema.optionalKey(Schema.Array(Schema.String)),
      internalDate: Schema.String,
      payload: Schema.optionalKey(Schema.Struct({ headers: Schema.optionalKey(Headers) })),
    }),
  ),
});
export interface ThreadSummary {
  subject: string;
  from: string;
  date: number;
  unread: boolean;
  messages: readonly [string, ...string[]];
}
export const threadSummary = (
  send: Send,
  thread: string,
): Effect.Effect<ThreadSummary, ToolFailure> =>
  get(
    send,
    `threads/${encodeURIComponent(thread)}?format=metadata&metadataHeaders=Subject&metadataHeaders=From`,
    Thread,
    notFoundOr("thread", thread),
  ).pipe(
    Effect.flatMap((value) =>
      Effect.gen(function* () {
        const first = value.messages[0];
        const last = value.messages[value.messages.length - 1]!;
        const date = yield* Schema.decodeUnknownEffect(InternalDate)(last.internalDate).pipe(
          Effect.mapError(unavailable),
        );
        return {
          subject: shorten(header(first.payload?.headers, "Subject"), 500),
          from: shorten(header(last.payload?.headers, "From"), 500),
          date: Number(date),
          unread: value.messages.some((m) => m.labelIds?.includes("UNREAD") === true),
          messages: [first.id, ...value.messages.slice(1).map((m) => m.id)],
        } satisfies ThreadSummary;
      }),
    ),
  );
export interface MessageSummary {
  from: string;
  subject: string;
  date: number;
}
/** One message as a view shows it, with bounded headers. */
export const messageSummary = (
  send: Send,
  message: string,
): Effect.Effect<MessageSummary, ToolFailure> =>
  get(
    send,
    `messages/${encodeURIComponent(message)}?format=metadata&metadataHeaders=Subject&metadataHeaders=From`,
    Schema.Struct({
      internalDate: InternalDate,
      payload: Schema.optionalKey(Schema.Struct({ headers: Schema.optionalKey(Headers) })),
    }),
    notFoundOr("message", message),
  ).pipe(
    Effect.map((value) => ({
      from: shorten(header(value.payload?.headers, "From"), 500),
      subject: shorten(header(value.payload?.headers, "Subject"), 500),
      date: Number(value.internalDate),
    })),
  );
/** Cloudflare allows a Worker six connections at once for one request; five leave one free. */
export const REQUESTS_AT_ONCE = 5;
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
        threadSummary(send, listed.id).pipe(
          Effect.mapError((error) => (error.code === "not_found" ? unavailable() : error)),
          Effect.map((thread) => ({
            thread: listed.id,
            subject: thread.subject,
            from: thread.from,
            date: isoSeconds(thread.date),
            snippet: decodeEntities(listed.snippet),
            messages: thread.messages.length,
            unread: thread.unread,
          })),
        ),
      { concurrency: REQUESTS_AT_ONCE },
    );
    return {
      threads,
      ...(list.nextPageToken === undefined ? {} : { next_page: list.nextPageToken }),
    };
  });

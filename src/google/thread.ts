import { Effect, Schema } from "effect";
import { notFound, ToolFailure } from "../mcp/failures";
import type { Send } from "../mcp/tools";
import { get } from "./gmail";
import { decodeEntities, htmlToText } from "./html";
import { decodeBody, header, RawMessage, readMessage, type Attachment, type Body } from "./message";

export const LIMIT = 32_000;
const MIN_TEXT = 1_000;
export interface Place {
  message: string;
  offset: number;
}
export const placeOf = (page: string): Place | null => {
  const match = /^([^+]+)(?:\+([0-9]+))?$/.exec(page);
  if (!match) return null;
  const offset = Number(match[2] ?? 0);
  return Number.isSafeInteger(offset) ? { message: match[1]!, offset } : null;
};
const pageOf = (message: string, offset = 0) => (offset ? `${message}+${offset}` : message);
const invalidPage = () =>
  new ToolFailure({
    code: "invalid_arguments",
    field: { name: "page", expects: "the next_page value of an earlier result" },
  });
export interface ThreadMessage {
  message: string;
  position: number;
  from: string;
  to: string[];
  cc: string[];
  bcc?: string[];
  date: string;
  labels: readonly string[];
  text: string;
  attachments: Attachment[];
  draft?: string;
  text_cut?: "start" | "end" | "both";
}
export interface ThreadResult {
  account: string;
  thread: string;
  subject: string;
  message_count: number;
  messages: ThreadMessage[];
  next_page?: string;
}
const FullThread = Schema.Struct({ messages: Schema.NonEmptyArray(RawMessage) });
const Bytes = Schema.Struct({ data: Schema.String });
const Drafts = Schema.Struct({
  drafts: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({ id: Schema.String, message: Schema.Struct({ id: Schema.String }) }),
    ),
  ),
  nextPageToken: Schema.optionalKey(Schema.String),
});
// Offsets count UTF-16 units, but a page must never end between the two halves of a character.
const safeEnd = (text: string, end: number) =>
  end > 0 &&
  end < text.length &&
  /[\uD800-\uDBFF]/.test(text[end - 1]!) &&
  /[\uDC00-\uDFFF]/.test(text[end]!)
    ? end - 1
    : end;

/** Owns the serialized result's budget, including every field and the continuation value. */
function fit(
  result: ThreadResult,
  message: ThreadMessage,
  offset: number,
  following: string | undefined,
): boolean {
  const rest = message.text.slice(offset);
  const whole: ThreadMessage = {
    ...message,
    text: rest,
    ...(offset ? { text_cut: "start" as const } : {}),
  };
  const { next_page: _next, ...base } = result;
  const withMessage = (
    value: ThreadMessage,
    next: string | undefined,
    messages = result.messages,
  ): ThreadResult => ({
    ...base,
    messages: [...messages, value],
    ...(next === undefined ? {} : { next_page: next }),
  });
  const size = (value: ThreadResult) => JSON.stringify(value).length;
  const append = (value: ThreadMessage, next: string | undefined) => {
    result.messages.push(value);
    if (next !== undefined) result.next_page = next;
    else delete result.next_page;
  };
  if (size(withMessage(whole, following)) <= LIMIT) {
    append(whole, following);
    return true;
  }
  if (result.messages.length && size(withMessage(whole, following, [])) <= LIMIT) {
    result.next_page = pageOf(message.message, offset);
    return false;
  }
  const piece = (end: number): ThreadMessage => ({
    ...message,
    text: message.text.slice(offset, end),
    text_cut: offset ? "both" : "end",
  });
  let low = 0;
  let high = Math.max(0, rest.length - 1);
  while (low < high) {
    const count = Math.ceil((low + high) / 2);
    const end = safeEnd(message.text, offset + count);
    if (size(withMessage(piece(end), pageOf(message.message, end))) <= LIMIT) low = count;
    else high = count - 1;
  }
  let end = safeEnd(message.text, offset + low);
  if (end - offset < MIN_TEXT) {
    if (result.messages.length) {
      result.next_page = pageOf(message.message, offset);
      return false;
    }
    end = Math.min(message.text.length, offset + MIN_TEXT);
    if (safeEnd(message.text, end) !== end) end++;
  }
  if (end === message.text.length) append(whole, following);
  else append(piece(end), pageOf(message.message, end));
  return false;
}
export const readThread = (
  send: Send,
  input: { account: string; thread: string; page: string | undefined },
): Effect.Effect<ThreadResult, ToolFailure> =>
  Effect.gen(function* () {
    // Alone, before any body or draft lookup, so this session acquires its token only once.
    const thread = yield* get(
      send,
      `threads/${encodeURIComponent(input.thread)}?format=full`,
      FullThread,
      (status) =>
        status === 404 || status === 400
          ? notFound("thread", input.thread)
          : new ToolFailure({ code: "google_unavailable" }),
    );
    const place = input.page === undefined ? null : placeOf(input.page);
    const start = place ? thread.messages.findIndex((m) => m.id === place.message) : 0;
    if ((input.page !== undefined && !place) || start < 0) return yield* Effect.fail(invalidPage());
    const base = (): ThreadResult => ({
      account: input.account,
      thread: input.thread,
      subject: header(thread.messages[0].payload.headers, "Subject"),
      message_count: thread.messages.length,
      messages: [],
    });
    const result = base();
    const prepared: ThreadMessage[] = [];
    for (let index = start; index < thread.messages.length; index++) {
      const parsed = yield* Effect.try({
        try: () => readMessage(thread.messages[index]!),
        catch: () => new ToolFailure({ code: "google_unavailable" }),
      });
      const heldHtml = [...parsed.html];
      const usedBodies = new Set<string>();
      const bodyText = (body: Body): Effect.Effect<string, ToolFailure> =>
        Effect.gen(function* () {
          let text: string;
          if ("text" in body) text = body.text;
          else {
            usedBodies.add(body.fetch);
            const bytes = yield* get(
              send,
              `messages/${encodeURIComponent(parsed.message)}/attachments/${encodeURIComponent(body.fetch)}`,
              Bytes,
            );
            text = yield* Effect.try({
              try: () => decodeBody(bytes.data),
              catch: () => new ToolFailure({ code: "google_unavailable" }),
            });
          }
          if (body.kind === "html") {
            if ("fetch" in body) heldHtml.push(text);
            return yield* Effect.tryPromise({
              try: () => htmlToText(text),
              catch: () => new ToolFailure({ code: "google_unavailable" }),
            });
          }
          if (!text.trim() && body.fallback)
            return (yield* Effect.forEach(body.fallback, bodyText)).join("\n\n");
          return text;
        });
      const text = (yield* Effect.forEach(parsed.body, bodyText)).join("\n\n");
      const offset = index === start ? (place?.offset ?? 0) : 0;
      if (offset > text.length || safeEnd(text, offset) !== offset)
        return yield* Effect.fail(invalidPage());
      const { body: _body, html: _html, attachments, ...fields } = parsed;
      const inlineIds = new Set(
        heldHtml.flatMap((html) =>
          Array.from(decodeEntities(html).matchAll(/cid:([^\s"'<>]+)/g), (match) => match[1]),
        ),
      );
      const message: ThreadMessage = {
        ...fields,
        position: index + 1,
        text,
        attachments: attachments
          .filter((a) => !a.bodyId || !usedBodies.has(a.bodyId))
          .map(({ contentId, bodyId: _bodyId, ...attachment }) => ({
            ...attachment,
            ...(contentId && inlineIds.has(contentId) ? { inline: true as const } : {}),
          })),
      };
      prepared.push(message);
      if (!fit(result, message, offset, thread.messages[index + 1]?.id)) break;
    }
    const wanted = new Set(
      result.messages.filter((m) => m.labels.includes("DRAFT")).map((m) => m.message),
    );
    if (wanted.size) {
      const found = new Map<string, string>();
      let page: string | undefined;
      do {
        const params = new URLSearchParams({ maxResults: "500" });
        if (page !== undefined) params.set("pageToken", page);
        const list = yield* get(send, `drafts?${params}`, Drafts);
        for (const draft of list.drafts ?? [])
          if (wanted.has(draft.message.id)) found.set(draft.message.id, draft.id);
        page = list.nextPageToken;
      } while (page !== undefined && found.size < wanted.size);
      // Draft IDs are part of the JSON budget too. Refit the already read messages with them.
      const fitted = base();
      for (const [i, message] of prepared.entries()) {
        const draft = found.get(message.message);
        if (
          !fit(
            fitted,
            { ...message, ...(draft ? { draft } : {}) },
            i === 0 ? (place?.offset ?? 0) : 0,
            thread.messages[start + i + 1]?.id,
          )
        )
          break;
      }
      return fitted;
    }
    return result;
  });

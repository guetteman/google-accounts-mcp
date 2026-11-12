import { Effect, Schema } from "effect";
import { notFound, ToolFailure } from "../mcp/failures";
import type { Send } from "../mcp/tools";
import {
  boundedAttachments,
  boundedText,
  BODY_PART_LEFT_OUT,
  BODY_BYTES_LEFT_OUT,
  HTML_UNREADABLE,
  MAX_BODY_BYTES,
  MAX_TEXT,
  PAGE_BODY_BYTES,
  shorten,
} from "./bounds";
import { get } from "./gmail";
import { htmlToText, referencedContentIds } from "./html";
import {
  decodeBody,
  header,
  RawMessage,
  readMessage,
  type Attachment,
  type Body,
  type BodyPart,
  type Message,
} from "./message";

export const LIMIT = 32_000;
const MIN_TEXT = 1_000;
export interface Place {
  message: string;
  offset: number;
}
export const placeOf = (page: string): Place | null => {
  const match = /^([A-Za-z0-9_-]+)(?:\+([0-9]+))?$/.exec(page);
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
  attachments_left_out?: number;
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
const bodyParts = (bodies: readonly Body[], fallbacks: boolean, parts = new Set<BodyPart>()) => {
  for (const body of bodies) {
    if (body.kind === "alternative") {
      bodyParts(body.preferred, fallbacks, parts);
      if (fallbacks) bodyParts(body.fallback, fallbacks, parts);
    } else parts.add(body);
  }
  return parts;
};
/** One page budget for both decoded bytes and deferred requests, counting each part once. */
export class BodyBudget {
  private left = { bytes: PAGE_BODY_BYTES, requests: 3 };
  private used = new Set<BodyPart>();
  private cost(bodies: readonly Body[], fallbacks: boolean) {
    const cost = { bytes: 0, requests: 0 };
    for (const part of bodyParts(bodies, fallbacks)) {
      if (this.used.has(part) || part.size > MAX_BODY_BYTES) continue;
      cost.bytes += part.size;
      if ("fetch" in part) cost.requests++;
    }
    return cost;
  }
  fits(bodies: readonly Body[], fallbacks = true): boolean {
    const cost = this.cost(bodies, fallbacks);
    return cost.bytes <= this.left.bytes && cost.requests <= this.left.requests;
  }
  bytesFit(bodies: readonly Body[]): boolean {
    return this.cost(bodies, false).bytes <= this.left.bytes;
  }
  take(part: BodyPart): string | undefined {
    if (part.size > MAX_BODY_BYTES)
      return `[The body of this message is too large to read: ${part.size} bytes.]`;
    if (this.used.has(part)) return;
    if ("fetch" in part && this.left.requests === 0) return BODY_PART_LEFT_OUT;
    if (part.size > this.left.bytes) return BODY_BYTES_LEFT_OUT;
    this.left.bytes -= part.size;
    if ("fetch" in part) this.left.requests--;
    this.used.add(part);
  }
}
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
type Decoded = { text: string } | { omitted: string };
/** The text of one message, under the caller's page budget. */
export const textOf = (
  send: Send,
  message: Message,
  budget: BodyBudget,
): Effect.Effect<
  {
    text: string;
    whole: boolean;
    read: (part: BodyPart) => Effect.Effect<Decoded, ToolFailure>;
  },
  ToolFailure
> =>
  Effect.gen(function* () {
    let whole = true;
    const decoded = new Map<BodyPart, Decoded>();
    const readPart = (part: BodyPart): Effect.Effect<Decoded, ToolFailure> =>
      Effect.gen(function* () {
        const cached = decoded.get(part);
        if (cached) return cached;
        const omitted = budget.take(part);
        if (omitted !== undefined) {
          whole = false;
          const value = { omitted };
          decoded.set(part, value);
          return value;
        }
        const data =
          "data" in part
            ? part.data
            : (yield* get(
                send,
                `messages/${encodeURIComponent(message.message)}/attachments/${encodeURIComponent(part.fetch)}`,
                Bytes,
              )).data;
        const text = yield* Effect.try({
          try: () => decodeBody(data),
          catch: () => new ToolFailure({ code: "google_unavailable" }),
        });
        const value = { text };
        decoded.set(part, value);
        return value;
      });
    let htmlFailed = false;
    const readBodies = (bodies: readonly Body[]): Effect.Effect<string, ToolFailure> =>
      Effect.gen(function* () {
        const pieces: string[] = [];
        let length = 0;
        for (const body of bodies) {
          const text = yield* bodyText(body);
          if (htmlFailed) return HTML_UNREADABLE;
          const joined = (pieces.length ? "\n\n" : "") + text;
          pieces.push(joined.slice(0, MAX_TEXT + 1 - length));
          length += joined.length;
          if (length > MAX_TEXT) {
            whole = false;
            break;
          }
        }
        return boundedText(pieces.join(""));
      });
    const bodyText = (body: Body): Effect.Effect<string, ToolFailure> =>
      Effect.gen(function* () {
        if (body.kind === "alternative") {
          if (!budget.bytesFit(body.preferred) && budget.fits(body.fallback, false)) {
            whole = false;
            return yield* readBodies(body.fallback);
          }
          const text = yield* readBodies(body.preferred);
          return text.trim() ? text : yield* readBodies(body.fallback);
        }
        const value = yield* readPart(body);
        if ("omitted" in value) return value.omitted;
        const { text } = value;
        if (body.kind === "html") {
          return yield* Effect.promise(() =>
            htmlToText(text, () => {
              whole = false;
            }).catch(() => {
              htmlFailed = true;
              whole = false;
              return HTML_UNREADABLE;
            }),
          );
        }
        return text;
      });
    const text = yield* readBodies(message.body);
    // The inline-image scan may inspect local HTML and bodies already read, but must
    // not download an unselected alternative merely to find its content IDs.
    const read = (part: BodyPart) =>
      "data" in part || decoded.has(part)
        ? readPart(part)
        : Effect.succeed({ omitted: BODY_PART_LEFT_OUT });
    return { text, whole, read };
  });

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
      subject: shorten(header(thread.messages[0].payload.headers, "Subject"), 500),
      message_count: thread.messages.length,
      messages: [],
    });
    const result = base();
    const prepared: ThreadMessage[] = [];
    const budget = new BodyBudget();
    for (let index = start; index < thread.messages.length; index++) {
      const parsed = yield* Effect.try({
        try: () => readMessage(thread.messages[index]!),
        catch: () => new ToolFailure({ code: "google_unavailable" }),
      });
      const scanHtml = parsed.attachments.some((a) => a.contentId) ? parsed.html : [];
      if (result.messages.length && !budget.fits([...parsed.body, ...scanHtml])) {
        result.next_page = pageOf(parsed.message);
        break;
      }
      const body = yield* textOf(send, parsed, budget);
      const { text, read: readPart } = body;
      const offset = index === start ? (place?.offset ?? 0) : 0;
      if (offset > text.length || safeEnd(text, offset) !== offset)
        return yield* Effect.fail(invalidPage());
      const { body: _body, html: _html, attachments, ...fields } = parsed;
      const heldHtml: string[] = [];
      if (attachments.some((a) => a.contentId)) {
        for (const part of new Set([...scanHtml, ...bodyParts(parsed.body, true)])) {
          if (part.kind !== "html") continue;
          const value = yield* readPart(part);
          if ("text" in value) heldHtml.push(value.text);
        }
      }
      const inlineIds = attachments.some((a) => a.contentId)
        ? yield* Effect.tryPromise({
            try: () => referencedContentIds(heldHtml),
            catch: () => new ToolFailure({ code: "google_unavailable" }),
          })
        : new Set<string>();
      const message: ThreadMessage = {
        ...fields,
        position: index + 1,
        text,
        ...boundedAttachments(
          attachments.map(({ contentId, ...attachment }) => ({
            ...attachment,
            ...(contentId && inlineIds.has(contentId) ? { inline: true as const } : {}),
          })),
        ),
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

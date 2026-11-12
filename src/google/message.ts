import { Schema } from "effect";
import { isoSeconds } from "../approvals/model";
import { boundedRecipients, PAGE_BODY_BYTES, shorten } from "./bounds";

export const Headers = Schema.Array(Schema.Struct({ name: Schema.String, value: Schema.String }));
interface RawPart {
  readonly partId: string;
  readonly mimeType: string;
  readonly filename: string;
  readonly headers?: typeof Headers.Type;
  readonly body: { readonly size: number; readonly data?: string; readonly attachmentId?: string };
  readonly parts?: readonly RawPart[];
}
const Part: Schema.Codec<RawPart, unknown> = Schema.suspend(() =>
  Schema.Struct({
    partId: Schema.String,
    mimeType: Schema.String,
    filename: Schema.String,
    headers: Schema.optionalKey(Headers),
    body: Schema.Struct({
      size: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      data: Schema.optionalKey(Schema.String),
      attachmentId: Schema.optionalKey(Schema.String),
    }),
    parts: Schema.optionalKey(Schema.Array(Part)),
  }),
);
export const InternalDate = Schema.String.check(
  Schema.makeFilter((value) => {
    const at = Number(value);
    return value.trim() !== "" && Number.isSafeInteger(at) && Math.abs(at) <= 8.64e15;
  }),
);
export const RawMessage = Schema.Struct({
  id: Schema.String,
  internalDate: InternalDate,
  labelIds: Schema.optionalKey(Schema.Array(Schema.String)),
  payload: Part,
});
export type RawMessage = typeof RawMessage.Type;
export const header = (headers: typeof Headers.Type | undefined, name: string): string =>
  headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
export type BodyPart = (
  | { kind: "plain" | "html"; data: string }
  | { kind: "plain" | "html"; fetch: string }
) & { size: number };
export type Body =
  | BodyPart
  | {
      kind: "alternative";
      preferred: Body[];
      fallback: Body[];
    };
export interface Attachment {
  attachment: string;
  filename: string;
  type: string;
  size: number;
  inline?: true;
}
export interface Message {
  message: string;
  from: string;
  to: string[];
  cc: string[];
  bcc?: string[];
  date: string;
  labels: readonly string[];
  body: Body[];
  html: BodyPart[];
  attachments: Array<Attachment & { contentId: string }>;
}
export const decodeBody = (data: string): string =>
  new TextDecoder().decode(
    Uint8Array.from(atob(data.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)),
  );

const addresses = (value: string): string[] => {
  const result: string[] = [];
  let quoted = false;
  let escaped = false;
  let angle = 0;
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quoted && c === "\\") {
      escaped = true;
      continue;
    }
    if (c === '"') quoted = !quoted;
    if (!quoted && c === "<") angle++;
    if (!quoted && c === ">") angle = Math.max(0, angle - 1);
    if (c === "," && !quoted && angle === 0) {
      if (value.slice(start, i).trim()) result.push(value.slice(start, i).trim());
      start = i + 1;
    }
  }
  if (value.slice(start).trim()) result.push(value.slice(start).trim());
  return result;
};
/** MIME selection stays pure. Bytes are decoded only after the page grants their cost. */
export const readMessage = (raw: RawMessage): Message => {
  const html: BodyPart[] = [];
  const parts: RawPart[] = [];
  const sources = new Map<RawPart, BodyPart>();
  const source = (part: RawPart): BodyPart => {
    const found = sources.get(part);
    if (found) return found;
    const kind = part.mimeType === "text/plain" ? "plain" : "html";
    const body: BodyPart = {
      kind,
      size: part.body.size,
      ...(part.body.data !== undefined
        ? { data: part.body.data }
        : part.body.attachmentId !== undefined
          ? { fetch: part.body.attachmentId }
          : { data: "" }),
    };
    sources.set(part, body);
    return body;
  };
  const collect = (part: RawPart) => {
    if (part.mimeType.startsWith("multipart/")) {
      part.parts?.forEach(collect);
      return;
    }
    parts.push(part);
    if (
      part.mimeType === "text/html" &&
      part.body.size <= PAGE_BODY_BYTES &&
      part.body.data !== undefined
    )
      html.push(source(part));
  };
  collect(raw.payload);
  const readable = (body: Body) => body.kind === "alternative" || body.size <= PAGE_BODY_BYTES;
  const hasPlain = (bodies: Body[]) =>
    bodies.some((body) => body.kind === "alternative" || (body.kind === "plain" && readable(body)));
  const select = (part: RawPart): Body[] => {
    if (part.mimeType === "multipart/alternative") {
      const alternatives = (part.parts ?? []).map(select);
      const readableHtml = alternatives.find((bodies) =>
        bodies.some((body) => body.kind === "html" && readable(body)),
      );
      const html =
        readableHtml ?? alternatives.find((bodies) => bodies.some((body) => body.kind === "html"));
      const plains = alternatives.filter(hasPlain);
      let chosen: Body[] = html ?? [];
      // A plain part can turn out blank only after its bytes have been read within the budget.
      for (const preferred of plains.reverse())
        chosen = chosen.length ? [{ kind: "alternative", preferred, fallback: chosen }] : preferred;
      if (plains.length || readableHtml) return chosen;
      return alternatives.find((bodies) => bodies.some((body) => body.kind === "plain")) ?? chosen;
    }
    if (part.mimeType.startsWith("multipart/")) return (part.parts ?? []).flatMap(select);
    if (part.filename) return [];
    if (part.mimeType !== "text/plain" && part.mimeType !== "text/html") return [];
    return [source(part)];
  };
  const body = select(raw.payload);
  return {
    message: raw.id,
    from: shorten(header(raw.payload.headers, "From"), 500),
    to: boundedRecipients(addresses(header(raw.payload.headers, "To"))),
    cc: boundedRecipients(addresses(header(raw.payload.headers, "Cc"))),
    ...(raw.payload.headers?.some((h) => h.name.toLowerCase() === "bcc")
      ? { bcc: boundedRecipients(addresses(header(raw.payload.headers, "Bcc"))) }
      : {}),
    date: isoSeconds(Number(raw.internalDate)),
    labels: raw.labelIds ?? [],
    body,
    html,
    attachments: parts
      .filter(
        (part) =>
          part.filename ||
          (part.body.attachmentId &&
            part.mimeType !== "text/plain" &&
            part.mimeType !== "text/html"),
      )
      .map((part) => ({
        attachment: part.partId || "0",
        filename: shorten(part.filename, 200),
        type: shorten(part.mimeType, 100),
        size: part.body.size,
        contentId: header(part.headers, "Content-ID").replace(/^<|>$/g, ""),
      })),
  };
};

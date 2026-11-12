import { Effect, Schema } from "effect";
import { notFound, ToolFailure } from "../mcp/failures";
import type { Send } from "../mcp/tools";
import { get } from "./gmail";
import { Headers, InternalDate, header } from "./message";
import { MAX_SUBJECT, envelopeLines, messageIds, parseAddressList, type Mailbox } from "./mail";

export type ReplyPlan = {
  thread: string;
  to: Mailbox[];
  cc: Mailbox[];
  subject: string;
  inReplyTo?: string;
  references?: string;
  answered: { from: string; subject: string; date: number };
};
const Message = Schema.Struct({
  threadId: Schema.String,
  internalDate: InternalDate,
  payload: Schema.Struct({ headers: Headers }),
});
export const unfold = (text: string) =>
  // oxlint-disable-next-line no-control-regex -- Sender-controlled headers must be unfolded before use.
  text.replace(/(?:\r\n|\r|\n)([ \t])/g, "$1").replace(/[\u0000-\u001f\u007f]/g, " ");
const recipientsFailure = () =>
  new ToolFailure({
    code: "invalid_arguments",
    field: {
      name: "to",
      expects:
        "given by you for this reply, because the server could not fill in the recipients of the answered message",
    },
  });
export const replyPlan = (
  send: Send,
  input: {
    account: string;
    message: string;
    all: boolean;
    given: { to: Mailbox[]; cc: Mailbox[]; bcc: Mailbox[] } | null;
  },
): Effect.Effect<ReplyPlan, ToolFailure> =>
  Effect.gen(function* () {
    const params = new URLSearchParams({ format: "metadata" });
    for (const name of ["From", "Reply-To", "To", "Cc", "Subject", "Message-ID", "References"])
      params.append("metadataHeaders", name);
    const message = yield* get(send, `messages/${input.message}?${params}`, Message, (status) =>
      status === 404 || status === 400
        ? notFound("message", input.message)
        : new ToolFailure({ code: "google_unavailable" }),
    );
    const source = (name: string) => header(message.payload.headers, name);
    const value = (name: string) => unfold(source(name));
    const parse = (name: string) => {
      if (source(name).length > 2000) throw recipientsFailure();
      const parsed = parseAddressList(value(name));
      if (!parsed) throw recipientsFailure();
      return parsed;
    };
    let to: Mailbox[];
    let cc: Mailbox[];
    try {
      if (input.given) ({ to, cc } = input.given);
      else {
        // A self-sent message is answered to its recipients, even when it has Reply-To.
        const from = source("From").length <= 2000 ? parseAddressList(value("From")) : null;
        const self =
          from?.length === 1 && from[0]!.address.toLowerCase() === input.account.toLowerCase();
        to = self ? parse("To") : parse(source("Reply-To") ? "Reply-To" : "From");
        if (!to.length) throw recipientsFailure();
        cc = input.all ? [...(self ? [] : parse("To")), ...parse("Cc")] : [];
        const seen = new Set(input.all ? [input.account.toLowerCase()] : []);
        const unique = (boxes: Mailbox[]) =>
          boxes.filter((box) => {
            const key = box.address.toLowerCase();
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });
        to = unique(to);
        cc = unique(cc);
        if (!to.length) throw recipientsFailure();
        // Count the header as written, including encoded names and continuation lines.
        let size = 0;
        for (const line of envelopeLines({ to, cc, bcc: [], subject: "", body: "" })) {
          size = line.startsWith(" ") ? size + 2 + line.length : line.length;
          if (size > 2000) throw recipientsFailure();
        }
      }
    } catch (error) {
      if (error instanceof ToolFailure) return yield* Effect.fail(recipientsFailure());
      throw error;
    }
    const original = value("Subject");
    let subject = /^re:/i.test(original) ? original : `Re: ${original}`;
    if (subject.length > MAX_SUBJECT) {
      let kept = "";
      for (const character of subject) {
        if (kept.length + character.length > MAX_SUBJECT - 1) break;
        kept += character;
      }
      subject = kept + "…";
    }
    const id = value("Message-ID");
    const inReplyTo = messageIds(id)[0] === id ? id : undefined;
    const references = inReplyTo
      ? [...(source("References").length > 4000 ? [] : messageIds(value("References"))), inReplyTo]
      : [];
    while ("References: ".length + references.join(" ").length > 900) references.shift();
    return {
      thread: message.threadId,
      to,
      cc,
      subject,
      ...(inReplyTo ? { inReplyTo, references: references.join(" ") } : {}),
      answered: { from: value("From"), subject: original, date: Number(message.internalDate) },
    };
  });

import { ToolFailure } from "../mcp/failures";
import { addresses } from "./message";

export const MAX_SUBJECT = 998;
const utf8 = new TextEncoder();
export type Mailbox = { name?: string; address: string; readonly __mailbox: unique symbol };
export type Outgoing = {
  to: Mailbox[];
  cc: Mailbox[];
  bcc: Mailbox[];
  subject: string;
  body: string;
  inReplyTo?: string;
  references?: string;
};
// oxlint-disable-next-line no-control-regex -- Mail headers must reject control characters.
const control = /[\u0000-\u001f\u007f]/;
const safeName = /^[a-zA-Z0-9 !#$%&'*+\-/=?^_`{|}~]*$/;
const addressOkay = (address: string) =>
  address.length <= 254 &&
  /^[\x21-\x7e]+@[\x21-\x7e]+$/.test(address) &&
  address.split("@").length === 2 &&
  !/[<>()[\],;:\\"]/.test(address);
export const parseMailbox = (text: string): Mailbox | null => {
  if (text.length > 998) return null;
  const value = text.trim();
  let address = value;
  let name = "";
  if (value.endsWith(">")) {
    const angle = value.lastIndexOf("<");
    if (angle < 0) return null;
    address = value.slice(angle + 1, -1);
    name = value.slice(0, angle).trim();
  }
  if (!addressOkay(address) || control.test(text)) return null;
  if (name.startsWith('"')) {
    if (!/^"(?:[^"\\]|\\.)*"$/.test(name)) return null;
    name = name.slice(1, -1).replace(/\\(.)/g, "$1");
  }
  if (/[@<>]/.test(name)) name = "";
  return { ...(name ? { name } : {}), address } as Mailbox;
};
export const parseAddressList = (value: string): Mailbox[] | null => {
  const result: Mailbox[] = [];
  for (const item of addresses(value)) {
    if (/^[^:<>]+:\s*;$/.test(item)) continue;
    const mailbox = parseMailbox(item);
    if (!mailbox) return null;
    result.push(mailbox);
  }
  return result;
};
/** Human-readable mailbox, before the MIME representation of a display name. */
export const mailboxText = (mailbox: Mailbox): string => {
  if (!mailbox.name) return mailbox.address;
  const quoted = Array.from(mailbox.name).some((c) => c.charCodeAt(0) <= 0x7f && !safeName.test(c));
  const name = quoted ? `"${mailbox.name.replace(/["\\]/g, "\\$&")}"` : mailbox.name;
  return `${name} <${mailbox.address}>`;
};
const base64 = (text: string) => {
  const bytes = utf8.encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};
export const rawMessage = (text: string) =>
  base64(text).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
const encodedWords = (text: string): string => {
  const words: string[] = [];
  let word = "";
  let size = 0;
  // 45 UTF-8 bytes become 60 base64 characters, plus the 12-character wrapper.
  for (const character of text) {
    const bytes = utf8.encode(character).length;
    if (size + bytes > 45) {
      words.push(`=?UTF-8?B?${base64(word)}?=`);
      word = "";
      size = 0;
    }
    word += character;
    size += bytes;
  }
  if (word) words.push(`=?UTF-8?B?${base64(word)}?=`);
  return words.join(" ");
};
const headerText = (text: string, prefix: number, name = false) =>
  /^[\x20-\x7e]*$/.test(text) &&
  !text.includes("=?") &&
  prefix + text.length <= 998 &&
  (!name || safeName.test(text))
    ? text
    : encodedWords(text);
/** Every token must fit on a continuation line; folding never splits an encoded word. */
const fold = (label: string | null, value: string): string[] => {
  const lines: string[] = [];
  let line = label === null ? "" : `${label}:`;
  for (const token of value.split(" ")) {
    if (line.length + 1 + token.length > 998) {
      lines.push(line);
      line = ` ${token}`;
    } else line += ` ${token}`;
  }
  lines.push(line);
  return lines;
};
export const messageIds = (value: string): string[] =>
  value.split(/\s+/).filter((token) => /^<[\x21-\x3b\x3d\x3f-\x7e]{1,250}>$/.test(token));
export const envelopeLines = (mail: Outgoing): string[] => {
  const lines: string[] = [];
  for (const [label, recipients] of [
    ["To", mail.to],
    ["Cc", mail.cc],
    ["Bcc", mail.bcc],
  ] as const) {
    if (!recipients.length) continue;
    const values = recipients.map((mailbox, index) => {
      // The branded type is not a substitute for validation at the final header gate.
      const addressLine =
        1 +
        mailbox.address.length +
        (mailbox.name ? 2 : 0) +
        (index < recipients.length - 1 ? 1 : 0);
      if (!addressOkay(mailbox.address) || addressLine > 998)
        throw new ToolFailure({
          code: "invalid_arguments",
          field: {
            name: label.toLowerCase(),
            expects: "mailboxes whose addresses fit on a mail header line",
          },
        });
      return mailbox.name
        ? `${headerText(mailbox.name, label.length + mailbox.address.length + 5, true)} <${mailbox.address}>`
        : mailbox.address;
    });
    // Fold between recipients first, and within encoded display names only when necessary.
    let line = `${label}:`;
    for (let i = 0; i < values.length; i++) {
      const value = values[i]! + (i < values.length - 1 ? "," : "");
      if (line.length + 1 + value.length <= 998) line += ` ${value}`;
      else {
        lines.push(line);
        const folded = fold(null, value);
        lines.push(...folded.slice(0, -1));
        line = folded.at(-1)!;
      }
    }
    lines.push(line);
  }
  if (mail.subject) lines.push(...fold("Subject", headerText(mail.subject, 9)));
  if (
    mail.inReplyTo &&
    messageIds(mail.inReplyTo).length === 1 &&
    messageIds(mail.inReplyTo)[0] === mail.inReplyTo
  ) {
    lines.push(...fold("In-Reply-To", mail.inReplyTo));
    const references = messageIds(mail.references ?? "");
    if (references.length) lines.push(...fold("References", references.join(" ")));
  }
  lines.push("MIME-Version: 1.0");
  return lines;
};
export const textPart = (body: string): { headers: string[]; content: string } => ({
  headers: ["Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64"],
  content:
    base64(body)
      .match(/.{1,76}/g)
      ?.join("\r\n") ?? "",
});
export const messageText = (mail: Outgoing): string => {
  const part = textPart(mail.body);
  return [...envelopeLines(mail), ...part.headers, "", part.content, ""].join("\r\n");
};

export interface FilePart {
  filename: string;
  type: string;
  bytes: Uint8Array;
}
/** Encode in multiples of 57 bytes, so chunks end on both a base64 and a MIME line boundary. */
export const mixedMessage = (mail: Outgoing, files: ReadonlyArray<FilePart>): Blob => {
  const boundary = `mixed-${crypto.randomUUID()}`;
  const text = textPart(mail.body);
  const parts: BlobPart[] = [
    [
      ...envelopeLines(mail),
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      ...text.headers,
      "",
      text.content,
      "",
    ].join("\r\n"),
  ];
  for (const file of files) {
    const type =
      file.type.length <= 100 && /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(file.type)
        ? file.type
        : "application/octet-stream";
    const filename = encodeURIComponent(file.filename.toWellFormed()).replace(
      /[!'()*]/g,
      (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
    );
    parts.push(
      `--${boundary}\r\nContent-Type: ${type}\r\nContent-Disposition: attachment; filename*=UTF-8''${filename}\r\nContent-Transfer-Encoding: base64\r\n\r\n`,
    );
    for (let at = 0; at < file.bytes.length; at += 57 * 512) {
      const encoded = btoa(String.fromCharCode(...file.bytes.subarray(at, at + 57 * 512)));
      parts.push(new Blob([encoded.match(/.{1,76}/g)!.join("\r\n") + "\r\n"]));
    }
    if (!file.bytes.length) parts.push("\r\n");
  }
  parts.push(`--${boundary}--\r\n`);
  return new Blob(parts);
};

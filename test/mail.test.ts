import { expect, it } from "vite-plus/test";
import {
  envelopeLines,
  MAX_SUBJECT,
  messageText,
  parseAddressList,
  parseMailbox,
  textPart,
  type Outgoing,
} from "../src/google/mail";
import { decodeWords } from "./support/draft";

const outgoing = (input: Partial<Outgoing> = {}): Outgoing => ({
  to: [],
  cc: [],
  bcc: [],
  subject: "",
  body: "",
  ...input,
});
it("parses only mailboxes, removes quoted-name escapes, and keeps address distinctions", () => {
  expect(parseMailbox('"Doe, \\"Alex\\"" <Alex+tag@example.com>')).toMatchObject({
    name: 'Doe, "Alex"',
    address: "Alex+tag@example.com",
  });
  expect(parseMailbox("a.b@example.com")).toMatchObject({ address: "a.b@example.com" });
  for (const text of [
    "",
    "no-at",
    "@example.com",
    "a@",
    "a@@b",
    "a b@example.com",
    "a@é.example",
    "a,b@example.com",
    "a(comment)@example.com",
    "a\\b@example.com",
    "a:b@example.com",
    "a;b@example.com",
    "a[b]@example.com",
    'a"b@example.com',
    "a\nb@example.com",
    "Name <a@example.com> trailing",
    '"unclosed <a@example.com>',
  ])
    expect(parseMailbox(text), text).toBeNull();
  expect(
    parseAddressList('"Doe, Alex" <alex@example.com>, undisclosed-recipients:;, sam@example.com'),
  ).toMatchObject([
    { name: "Doe, Alex", address: "alex@example.com" },
    { address: "sam@example.com" },
  ]);
  expect(parseAddressList("undisclosed-recipients:;")).toEqual([]);
  expect(parseAddressList("a@example.com, not a mailbox")).toBeNull();
});

it("bounds mailbox items at 998 characters and addresses at 254 before parsing", () => {
  const address = "a".repeat(242) + "@example.com";
  expect(address).toHaveLength(254);
  expect(parseMailbox(address)).toMatchObject({ address });
  expect(parseMailbox("a" + address)).toBeNull();
  const item = `${"n".repeat(998 - address.length - 3)} <${address}>`;
  expect(item).toHaveLength(998);
  expect(parseMailbox(item)).not.toBeNull();
  expect(parseMailbox("n" + item)).toBeNull();
});

it.each(["b", "<x@example.com>"])(
  "rejects a 300000-character whitespace item ending in %s in under 50 ms",
  (end) => {
    const text = "a" + " ".repeat(300_000 - end.length - 1) + end;
    const start = performance.now();
    const result = parseMailbox(text);
    const elapsed = performance.now() - start;
    expect(result).toBeNull();
    expect(elapsed).toBeLessThan(50);
  },
);

it("drops a name that looks like another address after unquoting", () => {
  for (const text of [
    "alice@good.example, Bob <mallory@evil.example>",
    '"Alice <alice@good.example>, Bob" <mallory@evil.example>',
    '"Alice <Bob" <mallory@evil.example>',
    '"Alice >Bob" <mallory@evil.example>',
  ])
    expect(parseMailbox(text)).toEqual({ address: "mallory@evil.example" });
});

it.each([
  ["José Núñez", "=?UTF-8?B?Sm9zw6kgTsO6w7Fleg==?="],
  ['A "quote"', "=?UTF-8?B?QSAicXVvdGUi?="],
  ["A \\ slash", "=?UTF-8?B?QSBcIHNsYXNo?="],
  ["Ends \\", "=?UTF-8?B?RW5kcyBc?="],
])("encodes the name %s with its golden RFC 2047 word", (name, expected) => {
  const mail = outgoing({ to: [parseMailbox(`${name} <sam@example.com>`)!] });
  expect(envelopeLines(mail)).toContain(`To: ${expected} <sam@example.com>`);
});

it.each(["ñ".repeat(998), "a".repeat(998), "An =?encoded-looking subject", "🙂".repeat(499)])(
  "encodes a long or ambiguous subject without changing its text (%#)",
  (subject) => {
    const lines = envelopeLines(outgoing({ subject }));
    const value = lines
      .join("\r\n")
      .split("\r\nMIME-Version")[0]!
      .slice("Subject: ".length)
      .replace(/\r\n /g, " ");
    const words = value.split(" ");
    expect(words.every((word) => /^=\?UTF-8\?B\?[^?]+\?=$/.test(word) && word.length <= 75)).toBe(
      true,
    );
    expect(decodeWords(value)).toBe(subject);
    expect(lines.every((line) => line.length <= 998)).toBe(true);
  },
);

it("bounds every line for long names, recipient lists, subjects and Unicode bodies", () => {
  const recipients = Array.from({ length: 70 }, (_, i) =>
    parseMailbox(`${"José ".repeat(100)} <sam${i}@example.com>`)!,
  );
  const body = "ñ🙂 and a long line ".repeat(1000) + "\n\r\nEnd";
  const mail = outgoing({
    to: recipients,
    cc: recipients,
    bcc: recipients,
    subject: "ñ".repeat(MAX_SUBJECT),
    body,
  });
  const text = messageText(mail);
  expect(text.split("\r\n").every((line) => line.length <= 998)).toBe(true);
  const encodedBody = text.slice(text.indexOf("\r\n\r\n") + 4).replace(/\s/g, "");
  expect(new TextDecoder().decode(Uint8Array.from(atob(encodedBody), (c) => c.charCodeAt(0)))).toBe(
    body,
  );
  expect(
    textPart(body)
      .content.split("\r\n")
      .every((line) => line.length <= 76),
  ).toBe(true);
});

it("leaves empty subjects out and preserves the plain text part as a reusable part", () => {
  expect(messageText(outgoing())).toBe(
    "MIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n\r\n",
  );
  expect(textPart("Hello")).toEqual({
    headers: ["Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64"],
    content: "SGVsbG8=",
  });
});

it("rechecks addresses and encodes header injection even from an unsafe caller", () => {
  const box = parseMailbox("sam@example.com")!;
  expect(() =>
    messageText(
      outgoing({ to: [{ ...box, address: "sam@example.com\r\nBcc: thief@example.com" }] }),
    ),
  ).toThrow();
  expect(() =>
    messageText(outgoing({ to: [{ ...box, address: "a".repeat(1000) + "@example.com" }] })),
  ).toThrow();
  const lines = envelopeLines(
    outgoing({
      subject: "Hi\r\nBcc: thief@example.com",
      inReplyTo: "<valid@example.com>",
      references: "junk <good@example.com> <bad id> <ok@example.com>",
    }),
  );
  expect(lines.join("\r\n")).not.toContain("\r\nBcc:");
  expect(lines.map((line) => line.split(":")[0])).toEqual([
    "Subject",
    "In-Reply-To",
    "References",
    "MIME-Version",
  ]);
  expect(lines).toContain("References: <good@example.com> <ok@example.com>");
  expect(
    envelopeLines(outgoing({ inReplyTo: "<bad\nid>", references: "<ok@example.com>" })),
  ).toEqual(["MIME-Version: 1.0"]);
});

it("F4: multipart file names round trip while unsafe media types cannot add headers or boundaries", async () => {
  const { mixedMessage } = await import("../src/google/mail");
  const { mime } = await import("./support/send");
  const files = [
    {
      filename: 'quote"\r\nBcc: x@example.com ñ',
      type: "image/png\r\nBcc: x@example.com",
      bytes: new Uint8Array([0, 255, 254, 0]),
    },
    {
      filename: "space and 'quote'.pdf",
      type: "application/pdf",
      bytes: new TextEncoder().encode("file content"),
    },
    { filename: "empty", type: "x/" + "a".repeat(99), bytes: new Uint8Array() },
  ];
  const blob = mixedMessage(outgoing({ subject: "Files", body: "Plain text\nunchanged" }), files);
  expect(blob).toBeInstanceOf(Blob);
  const text = await blob.text();
  const parsed = mime(text);
  expect(new TextDecoder().decode(parsed.parts[0]!.data)).toBe("Plain text\nunchanged");
  for (const [i, file] of files.entries()) {
    const sent = parsed.parts[i + 1]!;
    expect(sent.data).toEqual(file.bytes);
    expect(decodeURIComponent(sent.headers["Content-Disposition"]!.split("UTF-8''")[1]!)).toBe(
      file.filename,
    );
    expect(Object.keys(sent.headers)).toEqual([
      "Content-Type",
      "Content-Disposition",
      "Content-Transfer-Encoding",
    ]);
    expect(sent.headers["Content-Type"]).toBe(
      i === 1 ? "application/pdf" : "application/octet-stream",
    );
  }
});

it("F3: the multipart root named 0 never hides a file child named 0", async () => {
  const { attachmentPart, attachmentFields, readMessage } = await import("../src/google/message");
  const { message, part, tree } = await import("./support/thread");
  const raw = message();
  const file = part("application/pdf", "PDF", "0", "report.pdf");
  const multipart = { ...raw, payload: tree("multipart/mixed", [file]) };
  expect(attachmentPart(multipart, "0")).toBe(file);
  expect(attachmentFields(file)).toMatchObject({ filename: "report.pdf", attachment: "0" });
  const root = { ...raw, payload: { ...file, partId: "" } };
  expect(attachmentPart(root, "0")).toBe(root.payload);
  expect(readMessage(multipart).attachments).toHaveLength(1);
});

import { env } from "cloudflare:workers";
import { expect, it } from "vite-plus/test";
import "./support/account-checks";
import type { TestEnv } from "./env";
import { renderPage } from "../src/pages/render";
import { previews } from "../src/pages/previews";
import { parseAddressList } from "../src/google/mail";
import { answer, approve, page } from "./support/approvals";
import { PERSONAL } from "./support/permissions";
import {
  draftCall,
  draftFixture,
  decodedMail,
  replyCases,
  serveMessage,
  SOURCE,
} from "./support/draft";
import { google } from "./support/google";
import { ORIGIN, textOf } from "./support/worker";

const recipientAddresses = (text: string | undefined) => {
  const parsed = parseAddressList(text ?? "");
  expect(parsed).not.toBeNull();
  return parsed!.map((mailbox) => mailbox.address);
};
// Split the MIME header before decoding encoded words: a comma inside an encoded name
// does not separate recipients. decodedMail().headers is for reading a header's text.
const sentRecipients = (text: string, field: string) => {
  const header = text
    .split("\r\n\r\n")[0]!
    .replace(/\r\n[ \t]/g, " ")
    .split("\r\n")
    .find((line) => line.startsWith(`${field}:`));
  return header?.slice(field.length + 1).trim();
};

it("shows a new draft's normalized recipients, subject, deliberate copy and body in order", async () => {
  const f = await draftFixture("ask");
  const pending = await answer(
    await draftCall(f, {
      to: ['"Sam Lee" <sam@example.com>'],
      cc: ["kim@example.com"],
      bcc: ["jo@example.com"],
      subject: "Lunch",
      duplicate: 2,
      body: "Hello\n\nFull body",
    }),
  );
  expect(google.draftCreates).toEqual([]);
  const props = await page(f, pending.approval as string);
  expect(props.request.tool).toMatchObject({
    label: "Create draft",
    action: "create a draft",
    joiner: "in",
  });
  expect(props.request.values).toEqual([
    { name: "To", text: "Sam Lee <sam@example.com>", from: "agent" },
    { name: "Cc", text: "kim@example.com", from: "agent" },
    { name: "Bcc", text: "jo@example.com", from: "agent" },
    { name: "Subject", text: "Lunch", from: "agent" },
    { name: "Duplicate", text: "2 (a deliberate copy of an earlier call)", from: "agent" },
    { name: "Body", text: "Hello\n\nFull body", from: "agent" },
  ]);
  expect(textOf(await renderPage(props).text())).toContain(
    "The agent wrote the shaded text below.",
  );
});

it("always shows Body even when a new draft has no other values", async () => {
  const f = await draftFixture("ask");
  const pending = await answer(
    await draftCall(f, { body: "", to: [], subject: "", reply_all: false }),
  );
  expect((await page(f, pending.approval as string)).request.values).toEqual([
    { name: "Body", text: "", from: "agent" },
  ]);
});

it.each(replyCases)(
  "shows the exact reply recipients and subject that Approve creates for $name",
  async (test) => {
    const f = await draftFixture("ask");
    serveMessage(test.headers);
    const pending = await answer(
      await draftCall(f, { account: PERSONAL.toUpperCase(), reply_to: SOURCE, ...test.args }),
    );
    const id = pending.approval as string;
    const props = await page(f, id);
    const recipientsFrom = Object.keys(test.args).some((field) =>
      ["to", "cc", "bcc"].includes(field),
    )
      ? "agent"
      : "gmail";
    const values = props.request.values;
    expect(values.slice(0, 3)).toEqual([
      {
        name: "Answers a message from",
        text: "From" in test.headers ? test.headers.From : "Sam <sam@example.com>",
        from: "gmail",
      },
      { name: "Its subject", text: "Lunch", from: "gmail" },
      { name: "Its date", text: "Nov 11, 2026 at 09:41 UTC", from: "gmail" },
    ]);
    for (const [name, expected] of [
      ["To", test.to],
      ["Cc", test.cc],
      ["Bcc", "bcc" in test ? test.bcc : undefined],
    ] as const)
      expect(values.find((value) => value.name === name)).toEqual(
        expected ? { name, text: expected, from: recipientsFrom } : undefined,
      );
    expect(values.find((value) => value.name === "Subject")).toEqual({
      name: "Subject",
      text: "Re: Lunch",
      from: "gmail",
    });
    expect(values.at(-1)).toEqual({ name: "Body", text: "Hello", from: "agent" });
    const html = textOf(await renderPage(props).text());
    expect(html).toContain("Its subject, read from Gmail");
    expect(html).toContain("Body, written by the agent");
    if (test.to)
      expect(html).toContain(
        `To, ${recipientsFrom === "gmail" ? "read from Gmail" : "written by the agent"}`,
      );
    expect((await approve(f, id)).state.kind).toBe("succeeded");
    const mail = decodedMail();
    for (const name of ["To", "Cc", "Bcc"])
      expect(recipientAddresses(sentRecipients(mail.text, name))).toEqual(
        recipientAddresses(values.find((value) => value.name === name)?.text),
      );
    expect(mail.headers.Subject).toBe(values.find((value) => value.name === "Subject")?.text);
    expect(google.draftCreates).toHaveLength(1);
  },
);

it("cuts the answered sender at 1000 characters when recipients were given", async () => {
  const f = await draftFixture("ask");
  serveMessage({ From: "x".repeat(1500) + " <sam@example.com>" });
  const pending = await answer(await draftCall(f, { reply_to: SOURCE, to: ["sam@example.com"] }));
  const shown = await page(f, pending.approval as string);
  expect(shown.request.values[0]!.text).toBe("x".repeat(999) + "…");
});

const recipientNames = [
  { label: "comma", name: "Alice, Bob", shown: '"Alice, Bob"' },
  { label: "semicolon", name: "Alice; Bob", shown: '"Alice; Bob"' },
  { label: "colon", name: "Alice: Bob", shown: '"Alice: Bob"' },
  { label: "parentheses", name: "Alice (Bob)", shown: '"Alice (Bob)"' },
  { label: "period", name: "A. Bob", shown: '"A. Bob"' },
  { label: "brackets", name: "Alice [Bob]", shown: '"Alice [Bob]"' },
  { label: "quote", name: 'Alice "Bob"', shown: '"Alice \\"Bob\\""' },
  { label: "backslash", name: "Alice \\ Bob", shown: '"Alice \\\\ Bob"' },
  { label: "trailing backslash", name: "Alice \\", shown: '"Alice \\\\"' },
  { label: "Unicode", name: "José Núñez", shown: "José Núñez" },
  { label: "Unicode with comma", name: "José, Núñez", shown: '"José, Núñez"' },
  { label: "misleading address", name: "alice@good.example, Bob", shown: null },
  { label: "misleading angles", name: "Alice <alice@good.example>, Bob", shown: null },
  { label: "opening angle", name: "Alice <Bob", shown: null },
  { label: "closing angle", name: "Alice >Bob", shown: null },
];
it.each(["agent", "Reply-To"] as const)(
  "keeps recipient counts and order for names from %s",
  async (source) => {
    const f = await draftFixture("ask");
    for (const test of recipientNames) {
      const mailbox =
        source === "agent"
          ? `${test.name} <mallory@evil.example>`
          : `"${test.name.replace(/["\\]/g, "\\$&")}" <mallory@evil.example>`;
      const other = "Second <second@example.com>";
      serveMessage({ "Reply-To": `${mailbox}, ${other}` });
      const args = source === "agent" ? { to: [mailbox, other] } : { reply_to: SOURCE };
      const pending = await answer(await draftCall(f, { ...args, body: test.label }));
      const id = pending.approval as string;
      const shown = await page(f, id);
      const to = shown.request.values.find((value) => value.name === "To")!.text;
      expect((await approve(f, id)).state.kind).toBe("succeeded");
      const mail = decodedMail();
      const expected = ["mallory@evil.example", "second@example.com"];
      expect(recipientAddresses(to), test.label).toEqual(expected);
      expect(recipientAddresses(sentRecipients(mail.text, "To")), test.label).toEqual(expected);
      expect(to, test.label).toBe(
        `${test.shown === null ? "mallory@evil.example" : `${test.shown} <mallory@evil.example>`}, ${other}`,
      );
      if (test.shown === null)
        expect(sentRecipients(mail.text, "To")).toBe(`mallory@evil.example, ${other}`);
    }
  },
);

it("cuts the answered subject at 1000 characters", async () => {
  const f = await draftFixture("ask");
  serveMessage({ Subject: "s".repeat(200_000) });
  const pending = await answer(await draftCall(f, { reply_to: SOURCE }));
  const shown = await page(f, pending.approval as string);
  expect(shown.state).toMatchObject({ kind: "waiting", shown: true });
  const subject = shown.request.values.find((value) => value.name === "Its subject")!.text;
  expect(subject.length).toBeLessThanOrEqual(1000);
  expect(subject).toBe("s".repeat(999) + "…");
});

it.each([400, 404, 500])(
  "offers no Approve when the answered message read fails with %s",
  async (status) => {
    const f = await draftFixture("ask");
    const pending = await answer(await draftCall(f, { reply_to: SOURCE }));
    google.messageAnswers.set(SOURCE, () => new Response(null, { status }));
    const props = await page(f, pending.approval as string);
    expect(props.state).toMatchObject({ kind: "waiting", shown: false, digest: null });
    const html = await renderPage(props).text();
    expect(html).not.toContain(">Approve</button>");
    expect(html).toContain(">Reject</button>");
    expect(google.draftCreates).toEqual([]);
  },
);

it("renders draft, reply and two permission groups at 390 and 1280 pixels without overflow", async () => {
  for (const name of [
    "approval-waiting-draft",
    "approval-waiting-reply",
    "connection-some-allowed",
  ])
    for (const width of [390, 1280]) {
      const response = renderPage(previews[name]!);
      const result = await (
        await (env as TestEnv).TEST_BROWSER.fetch("http://browser/hydrate", {
          method: "POST",
          body: JSON.stringify({
            url: `${ORIGIN}/__pages/${name}`,
            html: await response.text(),
            headers: Object.fromEntries(response.headers),
            layout: true,
            width,
          }),
        })
      ).json<{ overflow: boolean; errors: string[] }>();
      expect(result.errors).toEqual([]);
      expect(result.overflow).toBe(false);
    }
}, 60_000);

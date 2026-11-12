import { env } from "cloudflare:workers";
import { expect, it } from "vite-plus/test";
import "./support/account-checks";
import type { TestEnv } from "./env";
import { renderPage } from "../src/pages/render";
import { previews } from "../src/pages/previews";
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
    for (const name of ["To", "Cc", "Bcc", "Subject"])
      expect(mail.headers[name]).toBe(values.find((value) => value.name === name)?.text);
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

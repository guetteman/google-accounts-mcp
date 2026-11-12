import { env } from "cloudflare:workers";
import { expect, it, vi } from "vite-plus/test";
import "./support/account-checks";
import type { TestEnv } from "./env";
import { renderPage } from "../src/pages/render";
import { previews } from "../src/pages/previews";
import { viewDigest } from "../src/approvals/view";
import { answer, approve, decided, digest, page, post } from "./support/approvals";
import { decodedMail, SOURCE } from "./support/draft";
import { google } from "./support/google";
import { fullMessage, mime, sendCall, sendFixture, serveFull } from "./support/send";
import { part, tree } from "./support/thread";
import { ORIGIN, textOf } from "./support/worker";

it("V1: a new send shows normalized recipients, subject, duplicate and its whole body without reading Gmail", async () => {
  const f = await sendFixture("send_message", "ask");
  const id = (
    await answer(
      await sendCall(f, "send_message", {
        to: ['"Sam Lee" <sam@example.com>'],
        cc: ["kim@example.com"],
        bcc: ["lee@example.com"],
        duplicate: 2,
        body: "Hello\n\nWhole body",
      }),
    )
  ).approval as string;
  const props = await page(f, id);
  expect(props.request.values).toEqual([
    { name: "To", text: "Sam Lee <sam@example.com>", from: "agent" },
    { name: "Cc", text: "kim@example.com", from: "agent" },
    { name: "Bcc", text: "lee@example.com", from: "agent" },
    { name: "Subject", text: "Lunch", from: "agent" },
    { name: "Duplicate", text: "2 (a deliberate copy of an earlier call)", from: "agent" },
    { name: "Body", text: "Hello\n\nWhole body", from: "agent" },
  ]);
  expect(textOf(await renderPage(props).text())).toContain(
    "The agent wrote the shaded text below.",
  );
  expect(google.messageRequests).toEqual([]);
  expect(google.fullDraftRequests).toEqual([]);
});

it("V2: the reply view and run use the same plan with Gmail recipients before the agent's body", async () => {
  const f = await sendFixture("send_reply", "ask");
  const id = (await answer(await sendCall(f, "send_reply", { reply_all: true, duplicate: 2 })))
    .approval as string;
  const props = await page(f, id);
  expect(props.request.values).toEqual([
    { name: "Answers a message from", text: "Sam <sam@example.com>", from: "gmail" },
    { name: "Its subject", text: "Lunch", from: "gmail" },
    { name: "Its date", text: "Nov 11, 2026 at 09:41 UTC", from: "gmail" },
    { name: "To", text: "Sam <sam@example.com>", from: "gmail" },
    { name: "Cc", text: "Kim <kim@example.com>, Jo <jo@example.com>", from: "gmail" },
    { name: "Subject", text: "Re: Lunch", from: "gmail" },
    { name: "Duplicate", text: "2 (a deliberate copy of an earlier call)", from: "agent" },
    { name: "Body", text: "Hello", from: "agent" },
  ]);
  expect(textOf(await renderPage(props).text())).toContain("To, read from Gmail");
  expect((await approve(f, id)).state.kind).toBe("succeeded");
  expect(decodedMail().headers.To).toBe(props.request.values[3]!.text);
  expect(decodedMail().headers.Cc).toBe(props.request.values[4]!.text);
  expect(decodedMail().body).toBe(props.request.values.at(-1)!.text);
});

it("V3: the forward lists every file before its exact quoted block without downloading files for the view", async () => {
  const f = await sendFixture("forward_message", "ask");
  const raw = fullMessage();
  raw.payload = {
    ...tree("multipart/mixed", [
      part("text/plain", "Lunch on Friday?", "0"),
      part("application/pdf", "PDF", "1", "menu.pdf"),
      { ...part("image/png", "", "2", ""), body: { size: 1000, attachmentId: "image" } },
    ]),
    headers: raw.payload.headers,
  };
  serveFull(raw);
  google.attachmentAnswers.set("image", () => Response.json({ data: "AA" }));
  const id = (
    await answer(
      await sendCall(f, "forward_message", {
        cc: ["kim@example.com"],
        bcc: ["sam@example.com"],
        duplicate: 2,
        body: "See below.",
      }),
    )
  ).approval as string;
  const props = await page(f, id);
  const values = props.request.values;
  expect(values.map((v) => v.name)).toEqual([
    "Forwards a message from",
    "Its subject",
    "Its date",
    "To",
    "Cc",
    "Bcc",
    "Subject",
    "Attachments",
    "Attachment 1",
    "Attachment 2",
    "Duplicate",
    "Note",
    "Forwarded text",
  ]);
  expect(values[7]).toEqual({
    name: "Attachments",
    text: "2 files, 1,003 bytes in all",
    from: "gmail",
  });
  expect(values[8]).toEqual({
    name: "Attachment 1",
    text: "menu.pdf (application/pdf, 3 bytes)",
    from: "gmail",
  });
  expect(values[9]).toEqual({
    name: "Attachment 2",
    text: "(no name) (image/png, 1,000 bytes)",
    from: "gmail",
  });
  expect(google.attachmentRequests).toEqual([]);
  expect(textOf(await renderPage(props).text())).toContain("Forwarded text, read from Gmail");
  expect((await approve(f, id)).state.kind).toBe("succeeded");
  const sent = new TextDecoder().decode(mime(google.uploads[0]!.message).parts[0]!.data);
  expect(sent).toBe(`See below.\n\n${values.at(-1)!.text}`);
});

it("V3: a forward with 31 files has no Approve", async () => {
  const f = await sendFixture("forward_message", "ask");
  const raw = fullMessage();
  raw.payload = {
    ...tree(
      "multipart/mixed",
      Array.from({ length: 31 }, (_, i) => part("image/png", "x", String(i), `f${i}`)),
    ),
    headers: raw.payload.headers,
  };
  serveFull(raw);
  const id = (await answer(await sendCall(f, "forward_message"))).approval as string;
  const props = await page(f, id);
  expect(props.state).toMatchObject({ kind: "waiting", shown: false });
  expect(await renderPage(props).text()).not.toContain(">Approve</button>");
  expect(google.attachmentRequests).toEqual([]);
});

it("V4: the draft view shows all 200 recipients and whole raw headers with its note outside the digest", async () => {
  const f = await sendFixture("send_draft", "ask");
  const to = Array.from({ length: 200 }, (_, i) => `Recipient ${i} <r${i}@example.com>`).join(", ");
  const raw = fullMessage({
    From: "Alex <alex.personal@example.com>",
    To: to,
    Cc: "kim@example.com",
    Bcc: "lee@example.com",
    Subject: "s".repeat(1100),
  });
  google.storedDrafts.set("existing-draft", raw);
  const id = (await answer(await sendCall(f, "send_draft"))).approval as string;
  const props = await page(f, id);
  expect(props.request.values.map((v) => v.name)).toEqual([
    "From",
    "To",
    "Cc",
    "Bcc",
    "Subject",
    "Body",
  ]);
  expect(props.request.values.find((v) => v.name === "To")!.text).toBe(to);
  expect(props.request.values.find((v) => v.name === "Subject")!.text).toBe("s".repeat(1100));
  expect(props.request.values.every((v) => v.from === "gmail")).toBe(true);
  const note =
    "This is the draft as it is in Gmail now. It is sent as it is at the moment you approve, also if it changed after this page loaded.";
  expect(props.request.tool.note).toBe(note);
  expect(textOf(await renderPage(props).text())).toContain(note);
  expect(
    await viewDigest({
      ...props.request,
      tool: { ...props.request.tool, note: "different page wording" },
    }),
  ).toBe(await viewDigest(props.request));
  expect(google.fullDraftRequests).toEqual([
    "https://gmail.googleapis.com/gmail/v1/users/me/drafts/existing-draft?format=full",
  ]);
});

it.each(["headers", "text", "html", "parts", "bytes", "files"])(
  "V5: incomplete draft %s never offers Approve or sends",
  async (kind) => {
    const f = await sendFixture("send_draft", "ask");
    const raw = fullMessage(
      kind === "headers"
        ? { To: Array.from({ length: 2000 }, (_, i) => `r${i}@example.com`).join(", ") }
        : {},
    );
    if (kind === "text")
      raw.payload.body = { size: 1_000_001, data: bytesForTest("x".repeat(1_000_001)) };
    if (kind === "html")
      raw.payload = {
        ...part("text/html", "<p>" + "x".repeat(1_000_001) + "</p>"),
        headers: raw.payload.headers,
      };
    if (kind === "bytes") raw.payload.body = { size: 5_000_001, attachmentId: "too-big" };
    if (kind === "parts")
      raw.payload = {
        ...tree(
          "multipart/mixed",
          Array.from({ length: 4 }, (_, i) => ({
            ...part("text/plain", "", String(i)),
            body: { size: 1, attachmentId: `p${i}` },
          })),
        ),
        headers: raw.payload.headers,
      };
    if (kind === "files")
      raw.payload = {
        ...tree(
          "multipart/mixed",
          Array.from({ length: 31 }, (_, i) => part("image/png", "x", String(i), `f${i}`)),
        ),
        headers: raw.payload.headers,
      };
    for (let i = 0; i < 4; i++)
      google.attachmentAnswers.set(`p${i}`, () => Response.json({ data: "eA" }));
    google.storedDrafts.set("existing-draft", raw);
    const id = (await answer(await sendCall(f, "send_draft"))).approval as string;
    const props = await page(f, id);
    expect(props.state).toMatchObject({ kind: "waiting", shown: false });
    const html = await renderPage(props).text();
    expect(html).not.toContain(">Approve</button>");
    expect(html).toContain(">Reject</button>");
    expect(
      (await decided(await post(f, id, "approve", { digest: "anything" }))).state,
    ).toMatchObject({ kind: "waiting", shown: false });
    expect(google.sends).toEqual([]);
  },
);
const bytesForTest = (value: string) =>
  btoa(value).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");

it.each(["send_reply", "forward_message", "send_draft"] as const)(
  "V6: %s offers no Approve on 404 or 500 and Reject still works",
  async (name) => {
    const f = await sendFixture(name, "ask");
    for (const status of [404, 500]) {
      const id = (await answer(await sendCall(f, name))).approval as string;
      const refuse = () => new Response(null, { status });
      if (name === "send_draft") google.fullDraftAnswers.set("existing-draft", refuse);
      else google.messageAnswers.set(SOURCE, refuse);
      const props = await page(f, id);
      expect(props.state).toMatchObject({ kind: "waiting", shown: false });
      const html = await renderPage(props).text();
      expect(html).not.toContain(">Approve</button>");
      expect(html).toContain(">Reject</button>");
      expect((await decided(await post(f, id, "reject"))).state.kind).toBe("rejected");
    }
    expect(google.sends).toEqual([]);
  },
);

it.each(["send_reply", "forward_message"] as const)(
  "V7: a changed %s subject prevents the send",
  async (name) => {
    const f = await sendFixture(name, "ask");
    const id = (await answer(await sendCall(f, name))).approval as string;
    const shown = await digest(f, id);
    serveFull(fullMessage({ Subject: "Changed after load" }));
    const props = await decided(await post(f, id, "approve", { digest: shown }));
    expect(props.state).toMatchObject({ kind: "waiting", changed: true });
    expect(google.sends).toEqual([]);
    expect(google.draftCreates).toEqual([]);
    expect(google.uploads).toEqual([]);
  },
);

it("V7: send_draft sends the changed draft as it is when approved", async () => {
  const f = await sendFixture("send_draft", "ask");
  const id = (await answer(await sendCall(f, "send_draft"))).approval as string;
  const shown = await digest(f, id);
  google.storedDrafts.set(
    "existing-draft",
    fullMessage({ To: "changed@example.com", Subject: "Changed after load" }),
  );
  expect((await decided(await post(f, id, "approve", { digest: shown }))).state.kind).toBe(
    "succeeded",
  );
  expect(google.sends).toHaveLength(1);
  expect(google.storedDrafts.has("existing-draft")).toBe(false);
});

it.each(["gone", "unreadable", "incomplete"])(
  "V7: a draft that becomes %s at Approve sends nothing",
  async (kind) => {
    const f = await sendFixture("send_draft", "ask");
    const id = (await answer(await sendCall(f, "send_draft"))).approval as string;
    const shown = await digest(f, id);
    if (kind === "gone") google.storedDrafts.delete("existing-draft");
    else if (kind === "unreadable")
      google.fullDraftAnswers.set("existing-draft", () => new Response(null, { status: 500 }));
    else google.storedDrafts.set("existing-draft", fullMessage({ Subject: "s".repeat(20_001) }));
    const props = await decided(await post(f, id, "approve", { digest: shown }));
    expect(props.state).toMatchObject({ kind: "waiting", shown: false });
    expect(google.sends).toEqual([]);
  },
);

it("V8: the four send previews render at 390 and 1280 pixels without overflow", async () => {
  for (const name of [
    "approval-waiting-send",
    "approval-waiting-send-reply",
    "approval-waiting-forward",
    "approval-waiting-send-draft",
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
            screenshot: `.work/screenshots/${name}-${width}.png`,
          }),
        })
      ).json<{ overflow: boolean; errors: string[] }>();
      expect(result.errors).toEqual([]);
      expect(result.overflow).toBe(false);
    }
}, 60_000);

it("V5: HTML that cannot be converted offers no Approve", async () => {
  const f = await sendFixture("send_draft", "ask");
  const raw = fullMessage();
  raw.payload = { ...part("text/html", "<p>Body</p>"), headers: raw.payload.headers };
  google.storedDrafts.set("existing-draft", raw);
  const html = await import("../src/google/html");
  vi.spyOn(html, "htmlToText").mockRejectedValueOnce(new Error("conversion unavailable"));
  const id = (await answer(await sendCall(f, "send_draft"))).approval as string;
  expect((await page(f, id)).state).toMatchObject({ kind: "waiting", shown: false });
  expect(google.sends).toEqual([]);
});

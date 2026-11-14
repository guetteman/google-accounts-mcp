import { MAX_FORWARD_FILES } from "../src/google/forward";
import { env } from "cloudflare:workers";
import { expect, it, vi } from "vite-plus/test";
import "./support/account-checks";
import type { TestEnv } from "./env";
import { renderPage } from "../src/pages/render";
import { previews } from "../src/pages/previews";
import { answer, approve, decided, digest, page, post } from "./support/approvals";
import { decodedMail, SOURCE } from "./support/draft";
import { google } from "./support/google";
import { fullMessage, mime, sendCall, sendFixture, serveFull } from "./support/send";
import { part, tree } from "./support/thread";
import { ORIGIN, textOf } from "./support/worker";

const originalForApproval = () => {
  const raw = fullMessage({
    From: "Original\r\n Sender <author@source.example>",
    To: "Alex <alex.personal@example.com>, Original To <to@source.example>",
    Cc: "Original Cc <cc@source.example>",
    Bcc: "Original Bcc <bcc@source.example>",
    "Reply-To": "Reply Destination <reply@source.example>",
    Subject: "Original subject for forwarding",
  });
  raw.payload = {
    ...tree("multipart/mixed", [
      part("text/plain", "Distinct original body.\nSecond original line.", "0"),
      part("application/pdf", "PDF", "1", "source-menu.pdf"),
      {
        ...part("message/rfc822", "", "2", "🙂".repeat(100) + ".eml"),
        body: { size: 5, attachmentId: "image" },
      },
      part("text/calendar", "BEGIN:VCALENDAR\nEND:VCALENDAR", "3"),
    ]),
    headers: raw.payload.headers,
  };
  return raw;
};

it("a new send shows normalized recipients, subject, duplicate and its whole body without reading Gmail", async () => {
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
  expect(props.request.tool).toMatchObject({ action: "send a message", joiner: "from" });
  expect(props.request.notes).toEqual([
    { text: "A sent message cannot be taken back.", warning: true },
  ]);
  expect(props.request.values).toEqual([
    { name: "To", text: "Sam Lee <sam@example.com>", from: "agent" },
    { name: "Cc", text: "kim@example.com", from: "agent" },
    { name: "Bcc", text: "lee@example.com", from: "agent" },
    { name: "Subject", text: "Lunch", from: "agent" },
    { name: "Duplicate", text: "2 (a deliberate copy of an earlier call)", from: "agent" },
    { name: "Body", text: "Hello\n\nWhole body", from: "agent" },
  ]);
  const html = (await renderPage(props).text()).replace(/<script[\s\S]*?<\/script>/g, "");
  expect(textOf(html)).toContain("The agent wrote the shaded text below.");
  expect(html).toMatch(/role="alert"[\s\S]*A sent message cannot be taken back/);
  expect(html.indexOf("A sent message cannot be taken back.")).toBeLessThan(
    html.indexOf(">Approve</button>"),
  );
  expect(google.messageRequests).toEqual([]);
  expect(google.fullDraftRequests).toEqual([]);
  expect((await approve(f, id)).state.kind).toBe("succeeded");
  const mail = decodedMail();
  expect(mail.entries.map(([name]) => name).sort()).toEqual(
    [
      "To",
      "Cc",
      "Bcc",
      "Subject",
      "MIME-Version",
      "Content-Type",
      "Content-Transfer-Encoding",
    ].sort(),
  );
  expect(mail.headers).toEqual({
    To: "Sam Lee <sam@example.com>",
    Cc: "kim@example.com",
    Bcc: "lee@example.com",
    Subject: "Lunch",
    "MIME-Version": "1.0",
    "Content-Type": "text/plain; charset=UTF-8",
    "Content-Transfer-Encoding": "base64",
  });
  expect(mail.body).toBe("Hello\n\nWhole body");
});

it("the reply view and run use the same plan with Gmail recipients before the agent's body", async () => {
  const f = await sendFixture("send_reply", "ask");
  serveFull(originalForApproval());
  const id = (
    await answer(
      await sendCall(f, "send_reply", {
        reply_all: true,
        duplicate: 2,
        body: "Reply body for destination.\nNext reply line.",
      }),
    )
  ).approval as string;
  const props = await page(f, id);
  expect(props.request.tool).toMatchObject({ action: "send a reply", joiner: "from" });
  expect(props.request.notes).toEqual([
    { text: "A sent message cannot be taken back.", warning: true },
  ]);
  expect(props.request.values).toEqual([
    {
      name: "Answers a message from",
      text: "Original Sender <author@source.example>",
      from: "gmail",
    },
    { name: "Its subject", text: "Original subject for forwarding", from: "gmail" },
    { name: "Its date", text: "Nov 11, 2026 at 09:41 UTC", from: "gmail" },
    { name: "To", text: "Reply Destination <reply@source.example>", from: "gmail" },
    {
      name: "Cc",
      text: "Original To <to@source.example>, Original Cc <cc@source.example>",
      from: "gmail",
    },
    { name: "Subject", text: "Re: Original subject for forwarding", from: "gmail" },
    { name: "Duplicate", text: "2 (a deliberate copy of an earlier call)", from: "agent" },
    { name: "Body", text: "Reply body for destination.\nNext reply line.", from: "agent" },
  ]);
  expect(textOf(await renderPage(props).text())).toContain("To, read from Gmail");
  expect((await approve(f, id)).state.kind).toBe("succeeded");
  expect(decodedMail().headers.To).toBe(props.request.values[3]!.text);
  expect(decodedMail().headers.Cc).toBe(props.request.values[4]!.text);
  expect(decodedMail().body).toBe(props.request.values.at(-1)!.text);
  const mail = decodedMail();
  expect(mail.entries.map(([name]) => name).sort()).toEqual(
    [
      "To",
      "Cc",
      "Subject",
      "In-Reply-To",
      "References",
      "MIME-Version",
      "Content-Type",
      "Content-Transfer-Encoding",
    ].sort(),
  );
  expect(mail.headers).toEqual({
    To: "Reply Destination <reply@source.example>",
    Cc: "Original To <to@source.example>, Original Cc <cc@source.example>",
    Subject: "Re: Original subject for forwarding",
    "In-Reply-To": "<source@example.com>",
    References: "<earlier@example.com> <source@example.com>",
    "MIME-Version": "1.0",
    "Content-Type": "text/plain; charset=UTF-8",
    "Content-Transfer-Encoding": "base64",
  });
  expect(mail.headers.Subject).toBe(
    props.request.values.find((value) => value.name === "Subject")!.text,
  );
  expect(mail.body).toBe("Reply body for destination.\nNext reply line.");
});

it("the forward lists every file before its exact quoted block without downloading files for the view", async () => {
  const f = await sendFixture("forward_message", "ask");
  serveFull(originalForApproval());
  google.attachmentAnswers.set("image", () => Response.json({ data: "SU1BR0U=" }));
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
  expect(props.request.tool).toMatchObject({ action: "forward a message", joiner: "from" });
  expect(props.request.notes).toEqual([
    { text: "A sent message cannot be taken back.", warning: true },
  ]);
  expect(values).toEqual([
    {
      name: "Forwards a message from",
      text: "Original Sender <author@source.example>",
      from: "gmail",
    },
    { name: "Its subject", text: "Original subject for forwarding", from: "gmail" },
    { name: "Its date", text: "Nov 11, 2026 at 09:41 UTC", from: "gmail" },
    { name: "To", text: "lee@example.com", from: "agent" },
    { name: "Cc", text: "kim@example.com", from: "agent" },
    { name: "Bcc", text: "sam@example.com", from: "agent" },
    { name: "Subject", text: "Fwd: Original subject for forwarding", from: "gmail" },
    { name: "Attachments", text: "2 files, 8 bytes in all", from: "gmail" },
    { name: "Attachment 1", text: "source-menu.pdf (application/pdf, 3 bytes)", from: "gmail" },
    {
      name: "Attachment 2",
      text: `${"🙂".repeat(70)}.eml (application/octet-stream, 5 bytes)`,
      from: "gmail",
    },
    {
      name: "Not forwarded",
      text: "1 part that is neither text nor a file, such as a calendar invitation",
      from: "gmail",
    },
    { name: "Duplicate", text: "2 (a deliberate copy of an earlier call)", from: "agent" },
    { name: "Note", text: "See below.", from: "agent" },
    {
      name: "Forwarded text",
      text: "---------- Forwarded message ---------\nFrom: Original Sender <author@source.example>\nDate: 2026-11-11T09:41:36Z\nSubject: Original subject for forwarding\nTo: Alex <alex.personal@example.com>, Original To <to@source.example>\nCc: Original Cc <cc@source.example>\n\nDistinct original body.\nSecond original line.",
      from: "gmail",
    },
  ]);
  expect(google.attachmentRequests).toEqual([]);
  expect(textOf(await renderPage(props).text())).toContain("Forwarded text, read from Gmail");
  expect((await approve(f, id)).state.kind).toBe("succeeded");
  const sent = new TextDecoder().decode(mime(google.uploads[0]!.message).parts[0]!.data);
  expect(sent).toBe(`See below.\n\n${values.at(-1)!.text}`);
  const mail = mime(google.uploads[0]!.message);
  expect(mail.entries.map(([name]) => name).sort()).toEqual(
    ["To", "Cc", "Bcc", "Subject", "MIME-Version", "Content-Type"].sort(),
  );
  expect(mail.headers.To).toBe("lee@example.com");
  expect(mail.headers.Cc).toBe("kim@example.com");
  expect(mail.headers.Bcc).toBe("sam@example.com");
  expect(mail.headers.Subject).toBe("Fwd: Original subject for forwarding");
  const files = mail.parts.slice(1).map((file) => ({
    filename: decodeURIComponent(
      /filename\*=UTF-8''([^\r\n]+)/.exec(file.headers["Content-Disposition"]!)![1]!,
    ),
    type: file.headers["Content-Type"],
    size: file.data.byteLength,
  }));
  expect(files).toEqual([
    { filename: "source-menu.pdf", type: "application/pdf", size: 3 },
    { filename: "🙂".repeat(70) + ".eml", type: "application/octet-stream", size: 5 },
  ]);
  expect(
    values.filter((value) => /^Attachment \d+$/.test(value.name)).map((value) => value.text),
  ).toEqual(files.map((file) => `${file.filename} (${file.type}, ${file.size} bytes)`));
  for (const name of ["To", "Cc", "Bcc", "Subject"])
    expect(mail.headers[name]).toBe(values.find((value) => value.name === name)!.text);
});

it("a forward above its attachment-count limit has no Approve", async () => {
  const f = await sendFixture("forward_message", "ask");
  const raw = fullMessage();
  raw.payload = {
    ...tree(
      "multipart/mixed",
      Array.from({ length: MAX_FORWARD_FILES + 1 }, (_, i) =>
        part("image/png", "x", String(i), `f${i}`),
      ),
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

it("the draft view shows all 200 recipients and whole raw headers with its warning above Approve", async () => {
  const f = await sendFixture("send_draft", "ask");
  const to = Array.from({ length: 200 }, (_, i) => `Recipient ${i} <r${i}@example.com>`).join(", ");
  const raw = fullMessage({
    From: "Draft Author <draft-author@example.com>",
    To: to,
    Cc: "Draft Cc <draft-cc@example.com>",
    Bcc: "Draft Bcc <draft-bcc@example.com>",
    Subject: "s".repeat(1100),
    "Reply-To": "Draft Reply <draft-reply@example.com>",
  });
  raw.payload = {
    ...tree("multipart/mixed", [
      part("text/plain", "Draft body written for the owner.\nDraft second line.", "0"),
      part("application/pdf", "DRAFT-PDF", "1", "draft-report.pdf"),
      part("text/plain", "DRAFT-TEXT", "2", "draft-note.txt"),
    ]),
    headers: raw.payload.headers,
  };
  google.storedDrafts.set("existing-draft", raw);
  const id = (await answer(await sendCall(f, "send_draft"))).approval as string;
  const props = await page(f, id);
  expect(props.request.tool).toMatchObject({ action: "send a draft", joiner: "from" });
  expect(props.request.values).toEqual([
    { name: "From", text: "Draft Author <draft-author@example.com>", from: "draft" },
    { name: "To", text: to, from: "draft" },
    { name: "Cc", text: "Draft Cc <draft-cc@example.com>", from: "draft" },
    { name: "Bcc", text: "Draft Bcc <draft-bcc@example.com>", from: "draft" },
    { name: "Subject", text: "s".repeat(1100), from: "draft" },
    { name: "Reply-To", text: "Draft Reply <draft-reply@example.com>", from: "draft" },
    { name: "Attachments", text: "2 files, 19 bytes in all", from: "draft" },
    { name: "Attachment 1", text: "draft-report.pdf (application/pdf, 9 bytes)", from: "draft" },
    { name: "Attachment 2", text: "draft-note.txt (text/plain, 10 bytes)", from: "draft" },
    { name: "Body", text: "Draft body written for the owner.\nDraft second line.", from: "draft" },
  ]);
  const note =
    "This is the draft as it is in Gmail now. It is sent as it is at the moment you approve, also if it changed after this page loaded.";
  expect(props.request.notes).toEqual([{ text: note, warning: true }]);
  const html = (await renderPage(props).text()).replace(/<script[\s\S]*?<\/script>/g, "");
  expect(textOf(html)).toContain(
    "The server read the shaded text below from a draft in Gmail. The agent or you may have written it.",
  );
  expect(textOf(html)).not.toContain("The agent did not write it.");
  const warning = /<div\b[^>]*role="alert"[\s\S]*?<\/div><\/div>/.exec(html)?.[0];
  expect(warning).toContain(note);
  expect(warning).toContain("bg-warning");
  expect(html.indexOf(note)).toBeGreaterThan(html.indexOf("That is the whole call."));
  expect(html.indexOf(note)).toBeLessThan(html.indexOf(">Approve</button>"));
  expect(google.fullDraftRequests).toEqual([
    "https://gmail.googleapis.com/gmail/v1/users/me/drafts/existing-draft?format=full",
  ]);
});

it.each(["headers", "text", "files", "calendar", "unknown part"])(
  "incomplete draft %s never offers Approve or sends",
  async (kind) => {
    const f = await sendFixture("send_draft", "ask");
    const raw = fullMessage(
      kind === "headers"
        ? { To: Array.from({ length: 2000 }, (_, i) => `r${i}@example.com`).join(", ") }
        : {},
    );
    if (kind === "text")
      raw.payload.body = { size: 1_000_001, data: bytesForTest("x".repeat(1_000_001)) };
    if (kind === "files")
      raw.payload = {
        ...tree(
          "multipart/mixed",
          Array.from({ length: 21 }, (_, i) => part("image/png", "x", String(i), `f${i}`)),
        ),
        headers: raw.payload.headers,
      };
    if (kind === "calendar" || kind === "unknown part")
      raw.payload = {
        ...tree("multipart/mixed", [
          part("text/plain", "Visible body", "0"),
          part(kind === "calendar" ? "text/calendar" : "application/x-inline", "Hidden part", "1"),
        ]),
        headers: raw.payload.headers,
      };
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
  "%s offers no Approve on 404 or 500 and Reject still works",
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
  "a changed %s subject prevents the send",
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

it("send_draft sends the changed draft as it is when approved, whatever digest was posted", async () => {
  const f = await sendFixture("send_draft", "ask");
  const id = (await answer(await sendCall(f, "send_draft"))).approval as string;
  expect((await page(f, id)).state).toMatchObject({ kind: "waiting", shown: true });
  google.storedDrafts.set(
    "existing-draft",
    fullMessage({ To: "changed@example.com", Subject: "Changed after load" }),
  );
  expect((await decided(await post(f, id, "approve", { digest: "wrong" }))).state.kind).toBe(
    "succeeded",
  );
  expect(google.sends).toHaveLength(1);
  expect(google.storedDrafts.has("existing-draft")).toBe(false);
});

it.each(["gone", "unreadable", "incomplete"])(
  "a draft that becomes %s at Approve sends nothing",
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

it("the four send previews render at 390 and 1280 pixels without overflow", async () => {
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
          }),
        })
      ).json<{ overflow: boolean; errors: string[] }>();
      expect(result.errors).toEqual([]);
      expect(result.overflow).toBe(false);
    }
}, 60_000);

it("HTML that cannot be converted offers no Approve", async () => {
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

it.each(["Owner <reply@example.com>", `${"Long name ".repeat(2_001)}<reply@example.com>`])(
  "shows the whole draft Reply-To after its subject, including a long value (%#)",
  async (replyTo) => {
    const f = await sendFixture("send_draft", "ask");
    google.storedDrafts.set("existing-draft", fullMessage({ "Reply-To": replyTo }));
    const id = (await answer(await sendCall(f, "send_draft"))).approval as string;
    const props = await page(f, id);
    const index = props.request.values.findIndex((value) => value.name === "Reply-To");
    expect(props.request.values[index]).toEqual({ name: "Reply-To", text: replyTo, from: "draft" });
    expect(props.request.values[index - 1]!.name).toBe("Subject");
  },
);

it.each(["From", "To", "Cc", "Bcc", "Subject", "Reply-To"])(
  "refuses to approve duplicate %s draft headers",
  async (name) => {
    const f = await sendFixture("send_draft", "ask");
    const raw = fullMessage({ [name]: "first@example.com" });
    raw.payload.headers.push({ name: name.toLowerCase(), value: "second@example.com" });
    google.storedDrafts.set("existing-draft", raw);
    const id = (await answer(await sendCall(f, "send_draft"))).approval as string;
    expect((await page(f, id)).state).toMatchObject({ kind: "waiting", shown: false });
    expect(
      (await decided(await post(f, id, "approve", { digest: "ignored for a draft" }))).state,
    ).toMatchObject({ kind: "waiting", shown: false });
    expect(google.sends).toEqual([]);
  },
);

it("offers no Approve for a forward whose attachment bytes exceed the limit", async () => {
  const f = await sendFixture("forward_message", "ask");
  const raw = fullMessage();
  raw.payload = {
    ...tree("multipart/mixed", [
      part("text/plain", "Small text", "0"),
      {
        ...part("image/png", "", "1", "large.png"),
        body: { size: 25_000_001, attachmentId: "large" },
      },
    ]),
    headers: raw.payload.headers,
  };
  serveFull(raw);
  const id = (await answer(await sendCall(f, "forward_message"))).approval as string;
  expect((await page(f, id)).state).toMatchObject({ kind: "waiting", shown: false });
  expect(google.attachmentRequests).toEqual([]);
  expect(google.sends).toEqual([]);
});

it.each([
  { sizes: [1], summary: "1 file, 1 byte in all", line: "1 byte" },
  { sizes: [0], summary: "1 file, 0 bytes in all", line: "0 bytes" },
  { sizes: [1, 1], summary: "2 files, 2 bytes in all", line: "1 byte" },
  { sizes: [0, 1], summary: "2 files, 1 byte in all", line: "0 bytes" },
])(
  "uses singular file and byte counts on the draft page (%#)",
  async ({ sizes, summary, line }) => {
    const f = await sendFixture("send_draft", "ask");
    const raw = fullMessage();
    raw.payload = {
      ...tree("multipart/mixed", [
        part("text/plain", "Body", "body"),
        ...sizes.map((size, i) => part("text/plain", "x".repeat(size), String(i), `f${i}.txt`)),
      ]),
      headers: raw.payload.headers,
    };
    google.storedDrafts.set("existing-draft", raw);
    const id = (await answer(await sendCall(f, "send_draft"))).approval as string;
    const values = (await page(f, id)).request.values;
    expect(values).toContainEqual({ name: "Attachments", text: summary, from: "draft" });
    expect(values).toContainEqual({
      name: "Attachment 1",
      text: `f0.txt (text/plain, ${line})`,
      from: "draft",
    });
  },
);

it("counts only omitted leaves, keeping body alternatives and attached mail out of that count", async () => {
  const f = await sendFixture("forward_message", "ask");
  const raw = fullMessage();
  raw.payload = {
    ...tree("multipart/mixed", [
      tree("multipart/alternative", [
        part("text/plain", "Visible body", "0"),
        part("text/html", "<p>Visible body</p>", "1"),
      ]),
      {
        ...part("message/rfc822", "Attached", "2", "attached.eml"),
        parts: [part("text/calendar", "Inside attached mail", "2.1")],
      },
      part("text/calendar", "Invitation", "3"),
      part("application/x-inline", "Other hidden content", "4"),
    ]),
    headers: raw.payload.headers,
  };
  serveFull(raw);
  const id = (await answer(await sendCall(f, "forward_message"))).approval as string;
  expect((await page(f, id)).request.values).toContainEqual({
    name: "Not forwarded",
    text: "2 parts that are neither text nor files, such as a calendar invitation",
    from: "gmail",
  });
});

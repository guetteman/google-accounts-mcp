import { expect, it } from "vite-plus/test";
import { HttpResponse } from "msw";
import "./support/account-checks";
import type { ThreadResult } from "../src/google/thread";
import { google, THREADS_URL } from "./support/google";
import { rpcResult } from "./support/oauth";
import { answer } from "./support/approvals";
import {
  callRows,
  expectError,
  googleTraffic,
  PERSONAL,
  unavailableMessage,
} from "./support/permissions";
import { allowed, bytes, message, part, read, serveThread, THREAD, tree } from "./support/thread";

const result = async (response: Response): Promise<ThreadResult> =>
  (await answer(response)) as unknown as ThreadResult;

it("returns three messages oldest first, with original headers, dates, labels and positions", async () => {
  const f = await allowed();
  const first = message("m1", "First\n\n> Earlier words stay");
  const headers = [
    { name: "sUbJeCt", value: "First subject" },
    { name: "From", value: '"Lee, Sam" <sam@example.com>' },
    {
      name: "To",
      value: '"Doe, Alex" <alex.personal@example.com>, Team <one,two@example.com>, kim@example.com',
    },
    { name: "Cc", value: '"Escaped \\"name, Sam" <sam@example.com>, jo@example.com' },
    { name: "Bcc", value: "hidden@example.com, other@example.com" },
  ];
  const third = { ...message("m3", "Third"), labelIds: ["TRASH"], internalDate: "1794390100999" };
  const second = {
    ...message("m2", "Second"),
    labelIds: undefined,
    payload: { ...part("text/plain", "Second"), headers: [] },
  };
  serveThread([{ ...first, payload: { ...first.payload, headers } }, second, third]);
  const found = await result(await read(f));
  expect(found).toMatchObject({
    account: PERSONAL,
    thread: THREAD,
    subject: "First subject",
    message_count: 3,
  });
  expect(found.messages).toEqual([
    {
      message: "m1",
      position: 1,
      from: '"Lee, Sam" <sam@example.com>',
      to: [
        '"Doe, Alex" <alex.personal@example.com>',
        "Team <one,two@example.com>",
        "kim@example.com",
      ],
      cc: ['"Escaped \\"name, Sam" <sam@example.com>', "jo@example.com"],
      bcc: ["hidden@example.com", "other@example.com"],
      date: "2026-11-11T09:41:36Z",
      labels: ["INBOX", "UNREAD"],
      text: "First\n\n> Earlier words stay",
      attachments: [],
    },
    {
      message: "m2",
      position: 2,
      from: "",
      to: [],
      cc: [],
      date: "2026-11-11T09:41:36Z",
      labels: [],
      text: "Second",
      attachments: [],
    },
    {
      message: "m3",
      position: 3,
      from: "Sam <sam@example.com>",
      to: [PERSONAL],
      cc: [],
      date: "2026-11-11T09:41:40Z",
      labels: ["TRASH"],
      text: "Third",
      attachments: [],
    },
  ]);
  expect(found.next_page).toBeUndefined();
  expect(google.threadRequests.map((r) => r.url)).toEqual([`${THREADS_URL}/${THREAD}?format=full`]);
});

it("selects bodies from the observed MIME trees and joins text around attachments", async () => {
  const f = await allowed();
  const plain = part("text/plain", "Plain", "0");
  const html = part("text/html", "<p>HTML</p>", "1");
  const pdf = {
    ...part("application/pdf", "", "2", "menu.pdf"),
    body: { size: 48213, attachmentId: "file-bytes" },
  };
  const alternative = tree("multipart/alternative", [plain, html]);
  const deferred = {
    ...part("text/plain", "", "0"),
    body: { size: 2, attachmentId: "blank-plain" },
  };
  google.attachmentAnswers.set("blank-plain", () => HttpResponse.json({ data: bytes("  ") }));
  const deferredHtml = {
    ...part("text/html", "", "1"),
    body: { size: 11, attachmentId: "fallback-html" },
  };
  google.attachmentAnswers.set("fallback-html", () =>
    HttpResponse.json({ data: bytes("<p>HTML</p>") }),
  );
  const cases = [
    [alternative, "Plain"],
    [tree("multipart/alternative", [deferred, html]), "HTML"],
    [tree("multipart/alternative", [deferred, deferredHtml]), "HTML"],
    [html, "HTML"],
    [tree("multipart/mixed", [alternative, pdf]), "Plain"],
    [tree("multipart/mixed", [tree("multipart/related", [html])]), "HTML"],
    [plain, "Plain"],
    [tree("multipart/mixed", [html, pdf, part("image/jpeg", "", "3", "photo.jpg")]), "HTML"],
    [tree("multipart/related", [alternative, part("image/png", "", "2", "logo.png")]), "Plain"],
    [
      tree("multipart/alternative", [
        part("text/plain", "  \n"),
        tree("multipart/mixed", [html, pdf, part("text/html", "<p>Tail</p>", "3")]),
      ]),
      "HTML\n\nTail",
    ],
    [tree("multipart/alternative", [html]), "HTML"],
    [
      tree("multipart/alternative", [
        tree("multipart/mixed", [part("text/plain", "  ", "0.0"), part("text/plain", "\n", "0.1")]),
        html,
      ]),
      "HTML",
    ],
    [
      tree("multipart/mixed", [
        plain,
        part("text/plain", "not body", "4", "notes.txt"),
        part("text/calendar", "not body", "5"),
        part("text/plain", "Tail", "6"),
      ]),
      "Plain\n\nTail",
    ],
    [part("image/png", "", "", "only.png"), ""],
  ] as const;
  serveThread(cases.map(([payload], i) => ({ ...message(`m${i}`), payload })));
  const found = await result(await read(f));
  expect(found.messages.map((m) => m.text)).toEqual(cases.map(([, text]) => text));
  expect(found.messages[2]!.attachments).toEqual([]);
  expect(google.attachmentRequests).toHaveLength(3);
});

it("decodes every charset as UTF-8 and replaces invalid bytes without failing", async () => {
  const f = await allowed();
  const utf8 = {
    ...part("text/plain", "ñ 🙂"),
    headers: [{ name: "Content-Type", value: "text/plain; charset=iso-8859-1" }],
  };
  const invalid = { ...part("text/plain"), body: { size: 3, data: btoa("a\xffb") } };
  serveThread([
    { ...message("m1"), payload: utf8 },
    { ...message("m2"), payload: invalid },
  ]);
  expect((await result(await read(f))).messages.map((m) => m.text)).toEqual(["ñ 🙂", "a�b"]);
});

it("names attachments by partId, marks only referenced images and never fetches unused HTML", async () => {
  const f = await allowed();
  const image = (id: string, cid: string) => ({
    ...part("image/png", "", id),
    headers: [{ name: "Content-ID", value: `<${cid}>` }],
    body: { size: 15, attachmentId: `volatile-${id}` },
  });
  const payload = tree("multipart/related", [
    tree("multipart/alternative", [
      part("text/plain", "Plain", "0.0"),
      part("text/html", '<p><img src="cid:logo"></p>', "0.1"),
    ]),
    image("1", "logo"),
    image("2", "unused"),
    {
      ...part("application/pdf", "", "3", "menu.pdf"),
      body: { size: 48213, attachmentId: "volatile-pdf" },
    },
  ]);
  const externalHtml = {
    ...part("text/html", "", "0.1"),
    body: { size: 90000, attachmentId: "unused-html" },
  };
  serveThread([
    { ...message("m1"), payload },
    { ...message("m2"), payload: image("", "root") },
    {
      ...message("m3"),
      payload: tree("multipart/alternative", [part("text/plain", "Plain", "0"), externalHtml]),
    },
    {
      ...message("m4"),
      payload: tree("multipart/alternative", [
        part("text/plain", "Plain", "0"),
        { ...part("text/plain", "", "1"), body: { size: 90000, attachmentId: "unused-plain" } },
      ]),
    },
    {
      ...message("m5"),
      payload: tree("multipart/mixed", [
        part("text/plain", "Plain", "0"),
        part("text/plain", "Notes", "1", "notes.txt"),
      ]),
    },
    {
      // A root that has parts and claims a file name would share the name 0 with its first part.
      ...message("m6"),
      payload: {
        ...tree("multipart/mixed", [
          { ...part("application/pdf", "", "0", "a.pdf"), body: { size: 7, attachmentId: "v" } },
        ]),
        filename: "root.bin",
      },
    },
  ]);
  const found = await result(await read(f));
  expect(found.messages[0]!.attachments).toEqual([
    { attachment: "1", filename: "", type: "image/png", size: 15, inline: true },
    { attachment: "2", filename: "", type: "image/png", size: 15 },
    { attachment: "3", filename: "menu.pdf", type: "application/pdf", size: 48213 },
  ]);
  expect(found.messages[1]!.attachments).toEqual([
    { attachment: "0", filename: "", type: "image/png", size: 15 },
  ]);
  expect(found.messages[2]!.attachments).toEqual([]);
  expect(found.messages[3]!.attachments).toEqual([]);
  expect(found.messages[4]!.attachments).toEqual([
    { attachment: "1", filename: "notes.txt", type: "text/plain", size: 5 },
  ]);
  expect(found.messages[5]!.attachments).toEqual([
    { attachment: "0", filename: "a.pdf", type: "application/pdf", size: 7 },
  ]);
  expect(google.attachmentRequests).toEqual([]);
});

it("fetches a deferred HTML body only on its page, including its inline references", async () => {
  const f = await allowed();
  const fetched = {
    ...part("text/html", "", "0"),
    body: { size: 90000, attachmentId: "body-bytes" },
  };
  const image = {
    ...part("image/png", "", "1", "logo.png"),
    headers: [{ name: "Content-ID", value: "<logo>" }],
    body: { size: 10, attachmentId: "image-bytes" },
  };
  serveThread([
    message("m1", "x".repeat(60000)),
    { ...message("m2"), payload: tree("multipart/related", [fetched, image]) },
  ]);
  google.attachmentAnswers.set("body-bytes", () =>
    HttpResponse.json({ size: 32, data: bytes('<p>Body<img src="cid:logo" alt="Logo"></p>') }),
  );
  const first = await result(await read(f));
  expect(google.attachmentRequests).toEqual([]);
  // Page starts after m1, so m1's body is never fetched again.
  const prior = { ...part("text/plain"), body: { size: 60000, attachmentId: "prior-body" } };
  serveThread([
    { ...message("m1"), payload: prior },
    { ...message("m2"), payload: tree("multipart/related", [fetched, image]) },
  ]);
  const second = await result(await read(f, { page: "m2" }));
  expect(first.next_page).toMatch(/^m1\+/);
  expect(second.messages[0]).toMatchObject({
    text: "Body[image: Logo]",
    attachments: [{ attachment: "1", inline: true }],
  });
  expect(google.attachmentRequests).toEqual([
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/m2/attachments/body-bytes`,
  ]);
});

it("resolves only result drafts, follows 500-item pages, stops when found, and uses only GET", async () => {
  const f = await allowed();
  const draft = { ...message("m1"), labelIds: ["DRAFT"] };
  serveThread([draft, { ...message("m2"), labelIds: ["DRAFT"] }]);
  google.draftAnswers.push(
    () =>
      HttpResponse.json({
        drafts: [{ id: "r-first", message: { id: "m1", threadId: THREAD } }],
        nextPageToken: "next",
      }),
    () =>
      HttpResponse.json({
        drafts: [{ id: "r-second", message: { id: "m2", threadId: THREAD } }],
        nextPageToken: "unneeded",
      }),
  );
  expect((await result(await read(f))).messages.map((m) => m.draft)).toEqual([
    "r-first",
    "r-second",
  ]);
  expect(google.draftRequests).toEqual([
    "https://gmail.googleapis.com/gmail/v1/users/me/drafts?maxResults=500",
    "https://gmail.googleapis.com/gmail/v1/users/me/drafts?maxResults=500&pageToken=next",
  ]);
  // A missing draft does not turn a successful read into a failure.
  expect((await result(await read(f))).messages.map((m) => m.draft)).toEqual([
    undefined,
    undefined,
  ]);
  serveThread([message()]);
  const before = google.draftRequests.length;
  await result(await read(f));
  expect(google.draftRequests).toHaveLength(before);
  expect(google.methods).toEqual(Array(6).fill("GET"));
});

it.each([400, 404])(
  "refuses a missing thread after Gmail's %s and records refused",
  async (status) => {
    const f = await allowed();
    google.threadAnswers.set(THREAD, () =>
      HttpResponse.json({ error: { message: "Invalid id value" } }, { status }),
    );
    await expectError(
      await read(f),
      "not_found",
      `No thread "${THREAD}" exists in ${PERSONAL}. A thread ID works only in the account that returned it.`,
    );
    expect((await callRows()).at(-1)?.outcome).toBe("refused");
  },
);

it("rejects invalid arguments before Gmail, and maps other statuses and malformed messages to google_unavailable", async () => {
  const f = await allowed();
  const before = googleTraffic().length;
  for (const [args, field] of [
    [{ thread: undefined }, "thread"],
    [{ thread: "" }, "thread"],
    [{ thread: 3 }, "thread"],
    [{ thread: "x".repeat(65) }, "thread"],
    [{ page: "" }, "page"],
    [{ page: 3 }, "page"],
    [{ page: "x".repeat(101) }, "page"],
    [{ account: 7 }, "account"],
  ] as const)
    await expectError(
      await read(f, args),
      "invalid_arguments",
      new RegExp(`The ${field} field must be`),
    );
  expect(googleTraffic().slice(before)).toEqual([]);
  for (const response of [
    new HttpResponse(null, { status: 500 }),
    HttpResponse.json({ messages: [] }),
    HttpResponse.json({ messages: [{ ...message(), internalDate: "not a date" }] }),
    HttpResponse.json({ messages: [{ ...message(), payload: { mimeType: "text/plain" } }] }),
  ]) {
    google.threadAnswers.set(THREAD, () => response.clone());
    await expectError(await read(f), "google_unavailable", unavailableMessage(PERSONAL));
  }
});

it("fills pages with whole messages or the longest text piece and all continuation fields", async () => {
  const f = await allowed();
  serveThread([message("m1", "a".repeat(60000))]);
  const sixty = await result(await read(f));
  expect(JSON.stringify(sixty).length).toBeLessThanOrEqual(32000);
  expect(sixty.messages[0]!.text_cut).toBe("end");
  serveThread([message("m1", "a".repeat(20000)), message("m2", "b".repeat(15000))]);
  const first = await result(await read(f));
  expect(first.messages.map((m) => m.message)).toEqual(["m1"]);
  expect(first.next_page).toBe("m2");
  expect((await result(await read(f, { page: first.next_page }))).messages[0]!.text).toHaveLength(
    15000,
  );
  serveThread([message("m1", "a".repeat(5000)), message("m2", "b".repeat(90000))]);
  const cut = await result(await read(f));
  expect(cut.messages.map((m) => m.text_cut)).toEqual([undefined, "end"]);
  expect(JSON.stringify(cut)).toHaveLength(32000);
  const continued = await result(await read(f, { page: cut.next_page }));
  expect(continued.messages[0]).toMatchObject({
    message: "m2",
    position: 2,
    from: "Sam <sam@example.com>",
    to: [PERSONAL],
    cc: [],
    labels: ["INBOX", "UNREAD"],
    attachments: [],
    text_cut: "both",
  });
  expect(JSON.stringify(continued)).toHaveLength(32000);
  let last = continued;
  while (last.next_page) last = await result(await read(f, { page: last.next_page }));
  expect(last.messages[0]!.text_cut).toBe("start");
  serveThread([message("m1", "a".repeat(30500)), message("m2", "b".repeat(60000))]);
  const sparse = await result(await read(f));
  expect(sparse.messages.map((m) => m.message)).toEqual(["m1"]);
  expect(sparse.next_page).toBe("m2");
});

it("bounds escaped JSON and reconstructs generated threads without splitting surrogate pairs", async () => {
  const f = await allowed();
  let seed = 24;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  const alphabet = ['"', "\\", "\n", "\t", "🙂", "a", "ñ"];
  for (let sample = 0; sample < 7; sample++) {
    const texts = Array.from({ length: 1 + (random() % 5) }, () =>
      Array.from(
        { length: 5000 + (random() % 35000) },
        () => alphabet[random() % alphabet.length],
      ).join(""),
    );
    const raw = texts.map((text, i) => ({
      ...message(`m${i}`, text),
      labelIds: sample === 1 ? ["DRAFT"] : ["INBOX"],
    }));
    serveThread(raw);
    google.draftAnswers = Array.from(
      { length: 30 },
      () => () =>
        HttpResponse.json({
          drafts: raw.map((m) => ({
            id: `r-${m.id}-${"d".repeat(24)}`,
            message: { id: m.id, threadId: THREAD },
          })),
        }),
    );
    const joined = texts.map(() => "");
    let page: string | undefined;
    const seen = new Set<string>();
    do {
      const response = await rpcResult(await read(f, page ? { page } : {}));
      const serialized = (response.content as { text: string }[])[0]!.text;
      expect(serialized.length).toBeLessThanOrEqual(32000);
      const found = JSON.parse(serialized) as ThreadResult;
      for (const m of found.messages) {
        expect(m.text).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u);
        joined[m.position - 1] += m.text;
      }
      page = found.next_page;
      if (page) {
        expect(seen.has(page)).toBe(false);
        seen.add(page);
      }
    } while (page);
    expect(joined).toEqual(texts);
  }
});

it("advances by 1000 characters even when 3000 labels exceed the budget", async () => {
  const f = await allowed();
  const labels = Array.from({ length: 3000 }, (_, i) => `Label_${i}_${"x".repeat(12)}`);
  serveThread([{ ...message("m1", "x".repeat(2600)), labelIds: labels }]);
  const parts: string[] = [];
  let page: string | undefined;
  do {
    const found = await result(await read(f, page ? { page } : {}));
    expect(JSON.stringify(found).length).toBeGreaterThan(32000);
    expect(found.messages[0]!.labels).toEqual(labels);
    parts.push(found.messages[0]!.text);
    page = found.next_page;
  } while (page);
  expect(parts.map((p) => p.length)).toEqual([1000, 1000, 600]);
  expect(parts.join("")).toBe("x".repeat(2600));
});

it("refuses a page with an unknown message or an offset past its text", async () => {
  const f = await allowed();
  serveThread([message("m1", "🙂Hello")]);
  for (const page of ["unknown", "m1+8", "m1+1", "m1+-1", "m1+999999999999999999999"])
    await expectError(
      await read(f, { page }),
      "invalid_arguments",
      "The page field must be the next_page value of an earlier result.",
    );
});

it("refreshes once before sequential body and draft requests", async () => {
  const f = await allowed(true);
  const fetched = { ...part("text/html"), body: { size: 10, attachmentId: "body" } };
  serveThread([{ ...message(), payload: fetched, labelIds: ["DRAFT"] }]);
  google.attachmentAnswers.set("body", () => HttpResponse.json({ data: bytes("<p>Draft</p>") }));
  google.draftAnswers.push(() =>
    HttpResponse.json({ drafts: [{ id: "r-draft", message: { id: "m1" } }] }),
  );
  expect((await result(await read(f))).messages[0]).toMatchObject({
    text: "Draft",
    draft: "r-draft",
  });
  expect(google.refreshTokens).toHaveLength(1);
  expect(google.methods).toEqual(["GET", "GET", "GET"]);
});

it("marks inline attachments only for Content-IDs named by a src attribute", async () => {
  const f = await allowed();
  const cases = [
    ['<img src="cid:x">', true],
    ["<img src=cid:x>", true],
    ['<img SRC="ci&#100;:x">', true],
    ['<img src="cid:xy">', false],
    ["<!-- cid:x -->", false],
    ['<!-- <img src="cid:x"> -->', false],
    ["<p>cid:x</p>", false],
    ['<p>&lt;img src="cid:x"&gt;</p>', false],
    ['<img data-src="cid:x">', false],
    ['<a href="cid:x">File</a>', false],
    ["<div title='src=\"cid:x\"'>Text</div>", false],
    ["<script>const text = 'src=\"cid:x\"';</script>", false],
    ["<style>div { background: url(cid:x); }</style>", false],
  ] as const;
  serveThread(
    cases.map(([html], i) => ({
      ...message(`m${i}`),
      payload: tree("multipart/related", [
        tree("multipart/alternative", [
          part("text/plain", "Plain", "0.0"),
          part("text/html", html, "0.1"),
        ]),
        {
          ...part("image/png", "", "1"),
          headers: [{ name: "Content-ID", value: "<x>" }],
          body: { size: 15, attachmentId: `image-${i}` },
        },
      ]),
    })),
  );
  const found = await result(await read(f));
  expect(found.messages.map((m) => m.attachments)).toEqual(
    cases.map(([, inline]) => [
      {
        attachment: "1",
        filename: "",
        type: "image/png",
        size: 15,
        ...(inline ? { inline: true } : {}),
      },
    ]),
  );
  expect(google.attachmentRequests).toEqual([]);
});

it.each([
  {
    field: "thread",
    ids: [
      "id/path",
      ".",
      "..",
      "%2e",
      "%2F",
      "a.b",
      "a+b",
      "id?query",
      "id#fragment",
      "id with space",
      "id\n",
      "é",
    ],
  },
  {
    field: "page",
    ids: ["m/1", ".", "..", "m.1+1", "%2e+1", "m1?query", "m1#fragment", "m1 +1", "m1+1x", "m1++2"],
  },
])("rejects invalid $field IDs before contacting Gmail", async ({ field, ids }) => {
  const f = await allowed();
  serveThread([message()]);
  const before = googleTraffic().length;
  for (const id of ids)
    await expectError(
      await read(f, { [field]: id }),
      "invalid_arguments",
      new RegExp(`The ${field} field must be`),
    );
  expect(googleTraffic().slice(before)).toEqual([]);
});

it("accepts letters, digits, hyphens and underscores in thread and page IDs", async () => {
  const f = await allowed();
  const thread = `${"a".repeat(60)}A-9_`;
  const id = "message_B-8";
  google.threadAnswers.set(thread, () => HttpResponse.json({ messages: [message(id)] }));
  const found = await result(await read(f, { thread, page: `${id}+1` }));
  expect(found).toMatchObject({
    thread,
    messages: [{ message: id, text: "ello", text_cut: "start" }],
  });
});

it("describes optional Bcc and shortened fields in the tool list", async () => {
  const f = await allowed();
  const listed = await rpcResult(await f.mcp.call());
  const tool = (listed.tools as Array<{ name: string; description: string }>).find(
    (t) => t.name === "read_thread",
  );
  expect(tool?.description).toContain(
    "`bcc` is present when the message has that header, which is normally mail that the account wrote.",
  );
  expect(tool?.description).toContain(
    "A very long field is shortened: a list of recipients ends with `… and N more`, and `attachments_left_out` counts the attachments that are not listed. A result has at most 32,000 characters.",
  );
});

it("keeps reading a thread when one message's HTML exceeds the parser's memory", async () => {
  const f = await allowed();
  const broken = "<tr><td>".repeat(12000);
  const body = tree("multipart/mixed", [
    part("text/html", '<p>Within this message<img src="cid:logo"></p>', "0"),
    part("text/html", broken, "1"),
    part("text/html", "<p>After broken HTML</p>", "2"),
    {
      ...part("image/png", "", "3", "logo.png"),
      headers: [{ name: "Content-ID", value: "<logo>" }],
    },
  ]);
  serveThread([
    message("m1", "Before"),
    { ...message("m2"), payload: body },
    message("m3", "After"),
  ]);
  expect((await result(await read(f))).messages.map((m) => m.text)).toEqual([
    "Before",
    "[The HTML of this message could not be converted to text.]",
    "After",
  ]);
  expect((await callRows()).at(-1)?.outcome).toBe("success");
});

it("skips oversized body parts without fetching, decoding or converting them", async () => {
  const f = await allowed();
  const expected = "[The body of this message is too large to read: 5000001 bytes.]";
  serveThread([
    {
      ...message("m1"),
      payload: { ...part("text/html"), body: { size: 5000001, attachmentId: "too-large" } },
    },
    {
      ...message("m2"),
      payload: { ...part("text/html"), body: { size: 5000001, data: "not valid base64!" } },
    },
    {
      ...message("m3"),
      payload: { ...part("text/plain"), body: { size: 5000001, data: "not valid base64!" } },
    },
  ]);
  expect((await result(await read(f))).messages.map((m) => m.text)).toEqual([
    expected,
    expected,
    expected,
  ]);
  expect(google.attachmentRequests).toEqual([]);
  serveThread([
    {
      ...message(),
      payload: { ...part("text/plain"), body: { size: 2000000, attachmentId: "allowed" } },
    },
  ]);
  google.attachmentAnswers.set("allowed", () => HttpResponse.json({ data: bytes("At the limit") }));
  expect((await result(await read(f))).messages[0]!.text).toBe("At the limit");
  expect(google.attachmentRequests).toHaveLength(1);
});

it("pages a message whose expanded quoted text is capped and ends with an omission notice", async () => {
  const f = await allowed();
  // The converter test covers 4,000 levels and 10,000 lines; this smaller expansion
  // still exceeds the text cap and exercises every page through the MCP boundary.
  const html = "<blockquote>".repeat(500) + "line<br>".repeat(1100) + "</blockquote>".repeat(500);
  serveThread([{ ...message("m1"), payload: part("text/html", html) }]);
  const pieces: string[] = [];
  let page: string | undefined;
  do {
    const found = await result(await read(f, page ? { page } : {}));
    expect(JSON.stringify(found).length).toBeLessThanOrEqual(32000);
    pieces.push(found.messages[0]!.text);
    page = found.next_page;
  } while (page);
  const text = pieces.join("");
  expect(text.length).toBeLessThanOrEqual(1000000);
  expect(
    text.endsWith(
      "\n[The rest of this message was left out: it is longer than 1,000,000 characters.]",
    ),
  ).toBe(true);
});

it("bounds escaped headers and attachment lists so every page stays within its JSON budget", async () => {
  const f = await allowed();
  const recipients = Array.from(
    { length: 2000 },
    (_, i) => `"${'\\"'.repeat(20)}${"\0".repeat(10)}" <r${i}@example.com>`,
  );
  const rawSubject = '"'.repeat(40000);
  const rawFrom = "\0".repeat(1000);
  const filename = '"'.repeat(1000);
  const type = "\0".repeat(300);
  const bodyText = "x".repeat(60000);
  const raw = message("m1", bodyText);
  serveThread([
    {
      ...raw,
      payload: {
        ...tree("multipart/mixed", [
          part("text/plain", bodyText, "0"),
          ...Array.from({ length: 300 }, (_, i) => ({
            ...part(type, "", String(i + 1), filename),
            body: { size: 500, attachmentId: `file-${i}` },
          })),
        ]),
        headers: [
          { name: "Subject", value: rawSubject },
          { name: "From", value: rawFrom },
          ...["To", "Cc", "Bcc"].map((name) => ({ name, value: recipients.join(", ") })),
        ],
      },
    },
  ]);
  const pieces: string[] = [];
  let page: string | undefined;
  do {
    const rpc = await rpcResult(await read(f, page ? { page } : {}));
    expect(rpc.isError).toBeUndefined();
    const serialized = (rpc.content as { text: string }[])[0]!.text;
    const found = JSON.parse(serialized) as ThreadResult;
    const m = found.messages[0]!;
    const { text: _text, labels: _labels, ...fields } = m;
    expect(JSON.stringify(fields).length).toBeLessThanOrEqual(25000);
    expect(serialized.length).toBeLessThanOrEqual(32000);
    expect(found.subject).toBe(rawSubject.slice(0, 499) + "…");
    expect(m.from).toBe(rawFrom.slice(0, 499) + "…");
    for (const addresses of [m.to, m.cc, m.bcc!]) {
      expect(JSON.stringify(addresses).length).toBeLessThanOrEqual(4000);
      const kept = addresses.slice(0, -1);
      expect(kept).toEqual(recipients.slice(0, kept.length));
      expect(addresses.at(-1)).toBe(`… and ${2000 - kept.length} more`);
    }
    expect(JSON.stringify(m.attachments).length).toBeLessThanOrEqual(6000);
    for (const attachment of m.attachments) {
      expect(attachment.filename).toBe(filename.slice(0, 199) + "…");
      expect(attachment.type).toBe(type.slice(0, 99) + "…");
    }
    expect(m.attachments.map((a) => a.attachment)).toEqual(
      Array.from({ length: m.attachments.length }, (_, i) => String(i + 1)),
    );
    expect(m.attachments_left_out).toBe(300 - m.attachments.length);
    pieces.push(m.text);
    page = found.next_page;
  } while (page);
  expect(pieces.join("")).toBe(bodyText);
});

it("fetches at most three deferred bodies per page and reads all ten messages", async () => {
  const f = await allowed();
  const ids = Array.from({ length: 10 }, (_, i) => `m${i}`);
  serveThread(
    ids.map((id, i) => ({
      ...message(id),
      payload:
        i === 2
          ? tree(
              "multipart/mixed",
              ["a", "b"].map((suffix) => ({
                ...part("text/html"),
                body: { size: 11, attachmentId: `${id}${suffix}` },
              })),
            )
          : { ...part("text/html"), body: { size: 11, attachmentId: id } },
    })),
  );
  for (const id of [...ids, "m2a", "m2b"])
    google.attachmentAnswers.set(id, () => HttpResponse.json({ data: bytes(`<p>${id}</p>`) }));
  const seen: string[] = [];
  let page: string | undefined;
  do {
    const before = google.attachmentRequests.length;
    const found = await result(await read(f, page ? { page } : {}));
    expect(google.attachmentRequests.length - before).toBeLessThanOrEqual(3);
    if (!page) {
      expect(found.messages.map((m) => m.message)).toEqual(["m0", "m1"]);
      expect(google.attachmentRequests).toHaveLength(2);
    }
    seen.push(...found.messages.map((m) => m.text));
    page = found.next_page;
  } while (page);
  expect(seen).toEqual(ids.map((id) => (id === "m2" ? "m2a\n\nm2b" : id)));
});

it("omits deferred parts beyond three in the first message and still reads the following message", async () => {
  const f = await allowed();
  const texts = ["One", "Two", "Three", "Four", "Five"];
  const body = tree(
    "multipart/mixed",
    texts.map((text, i) => {
      google.attachmentAnswers.set(`body-${i}`, () =>
        HttpResponse.json({ data: bytes(`<p>${text}</p>`) }),
      );
      return { ...part("text/html", "", String(i)), body: { size: 20, attachmentId: `body-${i}` } };
    }),
  );
  serveThread([{ ...message("m1"), payload: body }, message("m2", "Following")]);
  const omitted =
    "[A part of this message's body was left out: it has more than 3 parts that Gmail gives apart.]";
  const found = await result(await read(f));
  expect(found.messages.map((m) => m.text)).toEqual([
    ["One", "Two", "Three", omitted, omitted].join("\n\n"),
    "Following",
  ]);
  expect(found.next_page).toBeUndefined();
  expect(google.attachmentRequests).toEqual(
    [0, 1, 2].map(
      (i) => `https://gmail.googleapis.com/gmail/v1/users/me/messages/m1/attachments/body-${i}`,
    ),
  );
});

it("caps plain and joined MIME body text before applying page offsets", async () => {
  const f = await allowed();
  serveThread([
    message("m1", "x".repeat(1000001)),
    {
      ...message("m2"),
      payload: tree("multipart/mixed", [
        part("text/plain", "x".repeat(600000), "0"),
        part("text/plain", "y".repeat(600000), "1"),
      ]),
    },
  ]);
  const notice = "[The rest of this message was left out: it is longer than 1,000,000 characters.]";
  for (const id of ["m1", "m2"]) {
    const found = await result(await read(f, { page: `${id}+999000` }));
    const text = found.messages[0]!.text;
    expect(text.length).toBe(1000);
    expect(text.endsWith(`\n${notice}`)).toBe(true);
    await expectError(
      await read(f, { page: `${id}+1000001` }),
      "invalid_arguments",
      /The page field must be/,
    );
  }
});

it("bounds body bytes across parts and still reads the next message", async () => {
  const f = await allowed();
  const size = 1900000;
  const head = "<p>Read</p>";
  const row = "<div></div>";
  const html = head + row.repeat(Math.floor((size - head.length) / row.length));
  const data = bytes(html.padEnd(size, " "));
  for (let i = 0; i < 3; i++)
    google.attachmentAnswers.set(`large-${i}`, () => HttpResponse.json({ data }));
  serveThread([
    {
      ...message("m1"),
      payload: tree(
        "multipart/mixed",
        Array.from({ length: 3 }, (_, i) => ({
          ...part("text/html", "", String(i)),
          body: { size, attachmentId: `large-${i}` },
        })),
      ),
    },
    message("m2", "Following"),
  ]);
  const found = await result(await read(f));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(found.messages.map((m) => m.text)).toEqual([
    [
      "Read",
      ...Array(2).fill(
        "[A part of this message's body was left out: the message is too large to read whole.]",
      ),
    ].join("\n\n"),
    "Following",
  ]);
  expect(google.attachmentRequests).toEqual([
    "https://gmail.googleapis.com/gmail/v1/users/me/messages/m1/attachments/large-0",
  ]);
  expect(found.next_page).toBeUndefined();
}, 20000);

it("keeps shortened mail fields well formed at a surrogate boundary", async () => {
  const f = await allowed();
  const subject = "a".repeat(498) + "🙂tail";
  const from = "b".repeat(498) + "🙂tail";
  const filename = "c".repeat(198) + "🙂tail";
  const type = "d".repeat(98) + "🙂tail";
  serveThread([
    {
      ...message(),
      payload: {
        ...tree("multipart/mixed", [
          part("text/plain", "Body", "0"),
          part(type, "", "1", filename),
        ]),
        headers: [
          { name: "Subject", value: subject },
          { name: "From", value: from },
        ],
      },
    },
  ]);
  const found = await result(await read(f));
  const m = found.messages[0]!;
  for (const field of [found.subject, m.from, m.attachments[0]!.filename, m.attachments[0]!.type])
    expect(field.isWellFormed()).toBe(true);
  expect(found.subject).toBe("a".repeat(498) + "…");
  expect(m.from).toBe("b".repeat(498) + "…");
  expect(m.attachments[0]).toMatchObject({
    filename: "c".repeat(198) + "…",
    type: "d".repeat(98) + "…",
  });
});

it("reads the HTML alternative when the plain part is too large", async () => {
  const f = await allowed();
  for (const size of [5000001, 2000001]) {
    serveThread([
      {
        ...message(),
        payload: tree("multipart/alternative", [
          { ...part("text/plain", "", "0"), body: { size, attachmentId: "oversized" } },
          part("text/html", "<p>Readable HTML</p>", "1"),
        ]),
      },
    ]);
    expect((await result(await read(f))).messages[0]!.text).toBe("Readable HTML");
    expect(google.attachmentRequests).toEqual([]);
  }
  const deferred = (kind: string, size: number) => ({
    ...part(kind),
    body: { size, attachmentId: "unreadable" },
  });
  serveThread([
    {
      ...message(),
      payload: tree("multipart/alternative", [
        part("text/plain", " ", "0"),
        deferred("text/html", 2000001),
      ]),
    },
  ]);
  expect((await result(await read(f))).messages[0]!.text).toBe(
    "[A part of this message's body was left out: the message is too large to read whole.]",
  );
  serveThread([
    {
      ...message(),
      payload: tree("multipart/alternative", [
        deferred("text/html", 5000002),
        deferred("text/plain", 5000001),
      ]),
    },
  ]);
  expect((await result(await read(f))).messages[0]!.text).toBe(
    "[The body of this message is too large to read: 5000001 bytes.]",
  );
  expect(google.attachmentRequests).toEqual([]);
});

it("reads named multipart bodies and keeps named text leaves as attachments", async () => {
  const f = await allowed();
  const named = (mimeType: string, parts: Parameters<typeof tree>[1]) => ({
    ...tree(mimeType, parts),
    filename: "mail.eml",
  });
  const body = named("multipart/mixed", [
    named("multipart/alternative", [
      part("text/plain", "Readable", "0.0"),
      part("text/html", "<p>HTML</p>", "0.1"),
    ]),
    named("multipart/related", [part("text/html", "<p>Tail</p>", "1.0")]),
    part("text/plain", "Attachment", "2", "notes.txt"),
  ]);
  serveThread([{ ...message(), payload: body }]);
  const m = (await result(await read(f))).messages[0]!;
  expect(m.text).toBe("Readable\n\nTail");
  expect(m.attachments).toContainEqual({
    attachment: "2",
    filename: "notes.txt",
    type: "text/plain",
    size: 10,
  });
});

it("budgets inline-image HTML before deferring a message or decoding its parts", async () => {
  const f = await allowed();
  const image = {
    ...part("image/png", "", "2", "logo.png"),
    headers: [{ name: "Content-ID", value: "<logo>" }],
  };
  const plain = {
    ...part("text/plain", "Plain", "0"),
    body: { size: 200000, data: bytes("Plain") },
  };
  const html = {
    ...part("text/html", "", "1"),
    body: { size: 1300000, data: bytes('<img src="cid:logo">') },
  };
  const mixed = {
    ...message("m2"),
    payload: tree("multipart/related", [tree("multipart/alternative", [plain, html]), image]),
  };
  serveThread([
    {
      ...message("m1", "Prefix"),
      payload: { ...part("text/plain", "Prefix"), body: { size: 600000, data: bytes("Prefix") } },
    },
    mixed,
    {
      ...message("m3"),
      payload: { ...part("text/plain"), body: { size: 500000, attachmentId: "last" } },
    },
  ]);
  google.attachmentAnswers.set("last", () => HttpResponse.json({ data: bytes("Last") }));
  const first = await result(await read(f));
  expect(first.messages.map((m) => m.message)).toEqual(["m1"]);
  expect(first.next_page).toBe("m2");
  expect(google.attachmentRequests).toEqual([]);
  const second = await result(await read(f, { page: first.next_page }));
  expect(second.messages.map((m) => m.text)).toEqual(["Plain", "Last"]);
  expect(second.messages[0]!.attachments[0]!.inline).toBe(true);
  expect(second.next_page).toBeUndefined();
  expect(google.attachmentRequests).toHaveLength(1);

  // Unselected HTML still has a byte cost. This data must never reach the decoder.
  serveThread([
    {
      ...mixed,
      payload: tree("multipart/related", [
        tree("multipart/alternative", [
          plain,
          { ...html, body: { size: 2000001, data: "not valid base64!" } },
        ]),
        image,
      ]),
    },
  ]);
  const skipped = (await result(await read(f))).messages[0]!;
  expect(skipped.text).toBe("Plain");
  expect(skipped.attachments[0]!.inline).toBeUndefined();
  expect(google.attachmentRequests).toHaveLength(1);

  // Body conversion and the inline-image scan read the same part, not two copies.
  serveThread([
    {
      ...message("m1"),
      payload: tree("multipart/related", [
        { ...html, body: { size: 1500000, data: bytes('<p>Body<img src="cid:logo"></p>') } },
        image,
      ]),
    },
    {
      ...message("m2"),
      payload: { ...part("text/plain", "Tail"), body: { size: 500000, data: bytes("Tail") } },
    },
  ]);
  const shared = await result(await read(f));
  expect(shared.messages.map((m) => m.text)).toEqual(["Body[image]", "Tail"]);
  expect(shared.messages[0]!.attachments[0]!.inline).toBe(true);
  expect(shared.next_page).toBeUndefined();
});

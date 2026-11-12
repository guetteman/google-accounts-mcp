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

it("C1 C2 C3: returns three messages oldest first, with original headers, dates, labels and positions", async () => {
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

it("C4: selects bodies from the observed MIME trees and joins text around attachments", async () => {
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

it("C6: decodes every charset as UTF-8 and replaces invalid bytes without failing", async () => {
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

it("C7: names attachments by partId, marks only referenced images and never fetches unused HTML", async () => {
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
  expect(found.messages[2]!.attachments).toEqual([
    { attachment: "0.1", filename: "", type: "text/html", size: 90000 },
  ]);
  expect(google.attachmentRequests).toEqual([]);
});

it("C8: fetches a deferred HTML body only on its page, including its inline references", async () => {
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

it("C9 C10: resolves only result drafts, follows 500-item pages, stops when found, and uses only GET", async () => {
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
  "C11: refuses a missing thread after Gmail's %s and records refused",
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

it("C12: rejects invalid arguments before Gmail, and maps other statuses and malformed messages to google_unavailable", async () => {
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

it("S1 S2 S3: fills pages with whole messages or the longest text piece and all continuation fields", async () => {
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

it("S1 S4: bounds escaped JSON and reconstructs generated threads without splitting surrogate pairs", async () => {
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

it("S5: advances by 1000 characters even when 2000 recipients exceed the budget", async () => {
  const f = await allowed();
  const raw = message("m1", "x".repeat(2600));
  serveThread([
    {
      ...raw,
      payload: {
        ...raw.payload,
        headers: [
          {
            name: "To",
            value: Array.from({ length: 2000 }, (_, i) => `recipient${i}@example.com`).join(", "),
          },
        ],
      },
    },
  ]);
  const parts: string[] = [];
  let page: string | undefined;
  do {
    const found = await result(await read(f, page ? { page } : {}));
    expect(JSON.stringify(found).length).toBeGreaterThan(32000);
    expect(found.messages[0]!.to).toHaveLength(2000);
    parts.push(found.messages[0]!.text);
    page = found.next_page;
  } while (page);
  expect(parts.map((p) => p.length)).toEqual([1000, 1000, 600]);
  expect(parts.join("")).toBe("x".repeat(2600));
});

it("S6: refuses a page with an unknown message or an offset past its text", async () => {
  const f = await allowed();
  serveThread([message("m1", "🙂Hello")]);
  for (const page of ["unknown", "m1+8", "m1+1", "m1+-1", "m1+999999999999999999999"])
    await expectError(
      await read(f, { page }),
      "invalid_arguments",
      "The page field must be the next_page value of an earlier result.",
    );
});

it("S7: refreshes once before sequential body and draft requests", async () => {
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

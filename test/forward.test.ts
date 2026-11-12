import { expect, it, vi } from "vite-plus/test";
import { HttpResponse } from "msw";
import "./support/account-checks";
import { MAX_FORWARD_BYTES } from "../src/google/forward";
import { answer, approve, get, row } from "./support/approvals";
import { callRows, expectError, permission } from "./support/permissions";
import { onceRows, SOURCE, THREAD } from "./support/draft";
import { bytes, part, tree, serveThread, read } from "./support/thread";
import { decodeWords } from "./support/draft";
import { google, deferred } from "./support/google";
import { fullMessage, mime, never, sendCall, sendFixture, serveFull } from "./support/send";

it.each(["Lunch", "fWd: Lunch", "s".repeat(1100)])(
  "F1 F6: a forward of %s uses one full read and the original thread in its multipart upload",
  async (subject) => {
    const f = await sendFixture("forward_message");
    serveFull(fullMessage({ Subject: subject }));
    await answer(await sendCall(f, "forward_message", { body: "See below." }));
    expect(google.messageRequests).toEqual([
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${SOURCE}?format=full`,
    ]);
    expect(google.uploads).toHaveLength(1);
    const upload = google.uploads[0]!;
    expect(upload).toMatchObject({
      url: "https://gmail.googleapis.com/upload/gmail/v1/users/me/drafts?uploadType=multipart",
      redirect: "manual",
      metadata: { message: { threadId: THREAD } },
    });
    expect(upload.contentType).toMatch(/^multipart\/related; boundary=/);
    const mail = mime(upload.message);
    expect(decodeWords(mail.headers.Subject!)).toBe(
      /^fwd:/i.test(subject)
        ? subject
        : "Fwd: " + (subject.length > 1000 ? "s".repeat(999) + "…" : subject),
    );
    expect(mail.headers["In-Reply-To"]).toBeUndefined();
    expect(mail.headers.References).toBeUndefined();
    expect(new TextDecoder().decode(mail.parts[0]!.data)).toContain(
      "See below.\n\n---------- Forwarded message ---------",
    );
  },
);

it.each(["plain", "html", "alternative", "deferred"])(
  "F2: %s forwarded text is the same bounded text as read_thread",
  async (kind) => {
    const f = await sendFixture("forward_message");
    await permission(f, f.personal, true, "read_thread");
    const raw = fullMessage({ Cc: "Lee <lee@example.com>" });
    if (kind === "html")
      raw.payload = {
        ...part("text/html", '<p>Lunch on Friday?</p><a href="https://example.com">Menu</a>'),
        headers: raw.payload.headers,
      };
    if (kind === "alternative")
      raw.payload = {
        ...tree("multipart/alternative", [
          part("text/plain", "Plain takes precedence"),
          part("text/html", "<p>Other text</p>"),
        ]),
        headers: raw.payload.headers,
      };
    if (kind === "deferred") {
      raw.payload.body = { size: 16, attachmentId: "body-by-reference" };
      google.attachmentAnswers.set("body-by-reference", () =>
        Response.json({ data: bytes("Lunch on Friday?") }),
      );
    }
    serveFull(raw);
    serveThread([raw]);
    const thread = await answer(await read(f));
    const text = (thread.messages as Array<{ text: string }>)[0]!.text;
    await answer(await sendCall(f, "forward_message", { body: "See below." }));
    const forwarded = new TextDecoder().decode(mime(google.uploads[0]!.message).parts[0]!.data);
    expect(forwarded).toBe(
      `See below.\n\n---------- Forwarded message ---------\nFrom: Sam <sam@example.com>\nDate: 2026-11-11T09:41:36Z\nSubject: Lunch\nTo: Alex <alex.personal@example.com>, Kim <kim@example.com>\nCc: Lee <lee@example.com>\n\n${text}`,
    );
  },
);

it("F3 F4 F7: a forward carries every original file, inline image and hostile name with only its own permission", async () => {
  const f = await sendFixture("forward_message");
  const raw = fullMessage();
  const pdf = part("application/pdf", "PDF\u0000\u00ff", "1", "a.pdf");
  const image = {
    ...part("image/png", "", "2", "image.png"),
    body: { size: 4, attachmentId: "image-by-reference" },
  };
  const hostile = part(
    "image/png\r\nBcc: thief@example.com",
    "Inline image",
    "3",
    'quote"\r\nBcc: x@example.com ñ',
  );
  hostile.headers.push({ name: "Content-ID", value: "<logo>" });
  raw.payload = {
    ...tree("multipart/mixed", [
      part("text/html", '<p>See <img src="cid:logo"></p>', "0"),
      pdf,
      image,
      hostile,
    ]),
    headers: raw.payload.headers,
  };
  serveFull(raw);
  google.attachmentAnswers.set("image-by-reference", () => Response.json({ data: "AP_-AA==" }));
  await answer(await sendCall(f, "forward_message"));
  const mail = mime(google.uploads[0]!.message);
  expect(mail.parts).toHaveLength(4);
  expect(mail.parts[1]!.data).toEqual(new TextEncoder().encode("PDF\u0000\u00ff"));
  expect(mail.parts[2]!.data).toEqual(new Uint8Array([0, 255, 254, 0]));
  expect(mail.parts[3]!.data).toEqual(new TextEncoder().encode("Inline image"));
  const filename = mail.parts[3]!.headers["Content-Disposition"]!.split("UTF-8''")[1]!;
  expect(decodeURIComponent(filename)).toBe(hostile.filename);
  expect(mail.parts[3]!.headers["Content-Type"]).toBe("application/octet-stream");
  expect(Object.keys(mail.parts[3]!.headers)).toEqual([
    "Content-Type",
    "Content-Disposition",
    "Content-Transfer-Encoding",
  ]);
  expect(google.attachmentRequests).toHaveLength(1);
  expect(google.threadRequests).toEqual([]);
});

it("F3: all 30 long-named attachments survive without read_thread's list bound", async () => {
  const f = await sendFixture("forward_message");
  const raw = fullMessage();
  const files = Array.from({ length: 30 }, (_, i) =>
    part(
      "application/octet-stream",
      `file-${i}`,
      String(i + 1),
      "x".repeat(198) + String(i).padStart(2, "0"),
    ),
  );
  raw.payload = {
    ...tree("multipart/mixed", [part("text/plain", "Message", "0"), ...files]),
    headers: raw.payload.headers,
  };
  serveFull(raw);
  await answer(await sendCall(f, "forward_message"));
  const mail = mime(google.uploads[0]!.message);
  expect(mail.parts).toHaveLength(31);
  for (const [i, file] of files.entries()) {
    expect(new TextDecoder().decode(mail.parts[i + 1]!.data)).toBe(`file-${i}`);
    expect(
      decodeURIComponent(mail.parts[i + 1]!.headers["Content-Disposition"]!.split("UTF-8''")[1]!),
    ).toBe(file.filename);
  }
});

it.each(["size", "count", "actual", "413"])(
  "F5: %s limit refuses before sending and releases the call",
  async (kind) => {
    const f = await sendFixture("forward_message");
    const raw = fullMessage();
    const files = Array.from({ length: kind === "count" ? 31 : 1 }, (_, i) => ({
      ...part("application/octet-stream", "", String(i + 1), `file-${i}`),
      body: { size: kind === "size" ? 25_000_001 : 1, attachmentId: `file-${i}` },
    }));
    raw.payload = {
      ...tree("multipart/mixed", [part("text/plain", "Message", "0"), ...files]),
      headers: raw.payload.headers,
    };
    serveFull(raw);
    google.attachmentAnswers.set("file-0", () =>
      Response.json({ data: kind === "actual" ? "A".repeat(33_333_336) : "AA" }),
    );
    if (kind === "413") google.uploadAnswers.push(() => new Response(null, { status: 413 }));
    await expectError(
      await sendCall(f, "forward_message"),
      "message_too_large",
      kind === "count"
        ? "This forward would have 31 attachments. The limit is 30."
        : kind === "413"
          ? "Gmail refused this message as too large."
          : /^This forward would have [\d,]+ bytes of attachments and text. The limit is 25,000,000 bytes\.$/,
    );
    expect(google.sends).toEqual([]);
    expect(await onceRows()).toEqual([]);
    expect((await callRows()).at(-1)!.outcome).toBe("refused");
    if (kind === "size" || kind === "count") expect(google.attachmentRequests).toEqual([]);
  },
);

it("F5: a Worker forwards a near-limit attachment without another decoded copy", async () => {
  const f = await sendFixture("forward_message");
  const raw = fullMessage();
  const size = 24_999_000;
  const file = {
    ...part("application/octet-stream", "", "1", "large.bin"),
    body: { size, attachmentId: "large" },
  };
  raw.payload = {
    ...tree("multipart/mixed", [part("text/plain", "Message", "0"), file]),
    headers: raw.payload.headers,
  };
  serveFull(raw);
  google.attachmentAnswers.set("large", () => Response.json({ data: "AP_-".repeat(size / 3) }));
  expect(size).toBeLessThan(MAX_FORWARD_BYTES);
  await answer(await sendCall(f, "forward_message"));
  const decoded = mime(google.uploads[0]!.message);
  expect(decoded.parts[1]!.data).toHaveLength(size);
  expect(decoded.parts[1]!.data[0]).toBe(0);
  expect(decoded.parts[1]!.data[1]).toBe(255);
  expect(decoded.parts[1]!.data.at(-1)).toBe(254);
  expect(google.sends).toHaveLength(1);
});

it.each(["read", "create", "upload"])(
  "O3: a failed %s before send is known and its retry sends once",
  async (where) => {
    const f = await sendFixture(where === "create" ? "send_message" : "forward_message");
    const name = where === "create" ? "send_message" : "forward_message";
    if (where === "read")
      google.messageAnswers.set(SOURCE, () => new Response(null, { status: 503 }));
    else
      (where === "create" ? google.draftCreateAnswers : google.uploadAnswers).push(
        () => new Response(null, { status: 503 }),
      );
    await expectError(await sendCall(f, name), "google_unavailable", /Google could not complete/);
    expect(await onceRows()).toEqual([]);
    expect(google.sends).toEqual([]);
    expect((await callRows())[0]!.outcome).toBe("failed");
    serveFull();
    await answer(await sendCall(f, name));
    expect(google.sends).toHaveLength(1);
  },
);

it.each([false, true])(
  "O3 O4: an unanswered upload is a known failure, approved %s",
  async (approved) => {
    const f = await sendFixture("forward_message", approved ? "ask" : "allow");
    const id = approved
      ? ((await answer(await sendCall(f, "forward_message"))).approval as string)
      : null;
    const entered = deferred();
    google.uploadAnswers.push((request) => {
      entered.resolve();
      return never(request);
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const work = id ? approve(f, id) : sendCall(f, "forward_message");
    await entered.promise;
    await vi.advanceTimersByTimeAsync(10_000);
    if (id) {
      expect(((await work) as Awaited<ReturnType<typeof approve>>).state).toMatchObject({
        kind: "failed",
        message: expect.stringContaining("Google could not complete"),
      });
      expect((await row(id))!.outcome).toBe("failed");
      expect(await get(f, id)).toMatchObject({
        status: "failed",
        error: { code: "google_unavailable" },
      });
    } else
      await expectError(
        (await work) as Response,
        "google_unavailable",
        /Google could not complete/,
      );
    expect(await onceRows()).toEqual([]);
    expect(google.sends).toEqual([]);
    expect((await callRows())[0]!.outcome).toBe("failed");
    if (id) {
      const next = (await answer(await sendCall(f, "forward_message"))).approval as string;
      expect((await approve(f, next)).state.kind).toBe("succeeded");
    } else await answer(await sendCall(f, "forward_message"));
    expect(google.sends).toHaveLength(1);
  },
);

it.each([400, 404])(
  "T9: a missing forward source (%s) is not_found and can be retried",
  async (status) => {
    const f = await sendFixture("forward_message");
    google.messageAnswers.set(SOURCE, () => new Response(null, { status }));
    await expectError(await sendCall(f, "forward_message"), "not_found", /No message/);
    expect(await onceRows()).toEqual([]);
  },
);

it.each(["bad-data", "missing-data", "404", "padded"])(
  "F3: attachment bytes handle %s without sending bad data",
  async (kind) => {
    const f = await sendFixture("forward_message");
    const raw = fullMessage();
    raw.payload = {
      ...tree("multipart/mixed", [
        part("text/plain", "Message", "0"),
        {
          ...part("image/png", "", "1", "file.png"),
          body: { size: 1, ...(kind === "missing-data" ? {} : { attachmentId: "file" }) },
        },
      ]),
      headers: raw.payload.headers,
    };
    serveFull(raw);
    google.attachmentAnswers.set("file", () =>
      kind === "404"
        ? new Response(null, { status: 404 })
        : Response.json({ data: kind === "padded" ? "AA==" : "***" }),
    );
    if (kind === "padded") await answer(await sendCall(f, "forward_message"));
    else {
      await expectError(
        await sendCall(f, "forward_message"),
        kind === "404" ? "not_found" : "google_unavailable",
        kind === "404" ? /No attachment "1"/ : /Google could not complete/,
      );
      expect(google.sends).toEqual([]);
    }
  },
);

it.each(["create unreadable", "create lost", "create unanswered", "read lost"])(
  "O3: %s before send is known and a retry can send",
  async (kind) => {
    const f = await sendFixture(kind === "read lost" ? "send_reply" : "send_message");
    const name = kind === "read lost" ? "send_reply" : "send_message";
    const entered = deferred();
    if (kind === "read lost") google.messageAnswers.set(SOURCE, () => HttpResponse.error());
    else
      google.draftCreateAnswers.push((request) => {
        entered.resolve();
        if (kind === "create unanswered") return never(request);
        if (kind === "create lost") return HttpResponse.error();
        return new Response("not JSON");
      });
    if (kind === "create unanswered") vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const work = sendCall(f, name);
    if (kind === "create unanswered") {
      await entered.promise;
      await vi.advanceTimersByTimeAsync(10_000);
    }
    await expectError(await work, "google_unavailable", /Google could not complete/);
    expect(await onceRows()).toEqual([]);
    expect(google.sends).toEqual([]);
    expect((await callRows())[0]!.outcome).toBe("failed");
    serveFull();
    await answer(await sendCall(f, name));
    expect(google.sends).toHaveLength(1);
  },
);

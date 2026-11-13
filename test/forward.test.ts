import { expect, it, vi } from "vite-plus/test";
import { HttpResponse } from "msw";
import "./support/account-checks";
import { MAX_FORWARD_BYTES, MAX_FORWARD_FILES } from "../src/google/forward";
import { answer, approve, get, page, row } from "./support/approvals";
import { callRows, expectError, permission } from "./support/permissions";
import { onceRows, SOURCE, THREAD } from "./support/draft";
import { bytes, part, tree, serveThread, read } from "./support/thread";
import { decodeWords } from "./support/draft";
import { google, deferred, token } from "./support/google";
import {
  leftoverMessage,
  fullMessage,
  mime,
  never,
  sendCall,
  sendFixture,
  serveFull,
  setSend,
} from "./support/send";

it.each(["Lunch", "fWd: Lunch", "s".repeat(1100)])(
  "a forward of %s uses one full read and the original thread in its multipart upload",
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
  "%s forwarded text is whole and matches read_thread",
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

it("a forward carries every original file, inline image and hostile name with only its own permission", async () => {
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

it("all allowed long-named attachments survive without read_thread's list bound", async () => {
  const f = await sendFixture("forward_message");
  const raw = fullMessage();
  const files = Array.from({ length: MAX_FORWARD_FILES }, (_, i) =>
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
  expect(MAX_FORWARD_FILES).toBe(20);
  expect(mail.parts).toHaveLength(MAX_FORWARD_FILES + 1);
  for (const [i, file] of files.entries()) {
    expect(new TextDecoder().decode(mail.parts[i + 1]!.data)).toBe(`file-${i}`);
    expect(
      decodeURIComponent(mail.parts[i + 1]!.headers["Content-Disposition"]!.split("UTF-8''")[1]!),
    ).toBe(file.filename);
  }
});

it.each(["size", "count", "actual", "413"])(
  "%s limit refuses before sending and releases the call",
  async (kind) => {
    const f = await sendFixture("forward_message");
    const raw = fullMessage();
    const files = Array.from({ length: kind === "count" ? MAX_FORWARD_FILES + 1 : 1 }, (_, i) => ({
      ...part("application/octet-stream", "", String(i + 1), `file-${i}`),
      body: { size: kind === "size" ? MAX_FORWARD_BYTES + 1 : 1, attachmentId: `file-${i}` },
    }));
    raw.payload = {
      ...tree("multipart/mixed", [part("text/plain", "Message", "0"), ...files]),
      headers: raw.payload.headers,
    };
    serveFull(raw);
    google.attachmentAnswers.set("file-0", () =>
      Response.json({
        data: kind === "actual" ? "A".repeat(4 * Math.ceil((MAX_FORWARD_BYTES + 1) / 3)) : "AA",
      }),
    );
    if (kind === "413") google.uploadAnswers.push(() => new Response(null, { status: 413 }));
    const quoted =
      "---------- Forwarded message ---------\nFrom: Sam <sam@example.com>\nDate: 2026-11-11T09:41:36Z\nSubject: Lunch\nTo: Alex <alex.personal@example.com>, Kim <kim@example.com>\nCc: Jo <jo@example.com>, sam@EXAMPLE.com, ALEX.PERSONAL@EXAMPLE.COM\n\nMessage";
    const total =
      new TextEncoder().encode(quoted).byteLength +
      (kind === "size" ? MAX_FORWARD_BYTES + 1 : 3 * Math.ceil((MAX_FORWARD_BYTES + 1) / 3));
    await expectError(
      await sendCall(f, "forward_message"),
      "message_too_large",
      kind === "count"
        ? `This message would have ${MAX_FORWARD_FILES + 1} attachments. The limit is ${MAX_FORWARD_FILES}.`
        : kind === "413"
          ? "Gmail refused this message as too large."
          : `This message would have ${total.toLocaleString("en-US")} bytes of attachments and text. The limit is ${MAX_FORWARD_BYTES.toLocaleString("en-US")} bytes.`,
    );
    expect(google.sends).toEqual([]);
    expect(await onceRows()).toEqual([]);
    expect((await callRows()).at(-1)!.outcome).toBe("refused");
    if (kind === "size" || kind === "count") expect(google.attachmentRequests).toEqual([]);
  },
);

it("a large referenced attachment keeps its length and sampled bytes across encoding blocks", async () => {
  const f = await sendFixture("forward_message");
  const raw = fullMessage();
  const size = 3_000_000;
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
  "a failed %s before send is known and its retry sends once",
  async (where) => {
    const f = await sendFixture(where === "create" ? "send_message" : "forward_message");
    const name = where === "create" ? "send_message" : "forward_message";
    if (where === "read")
      google.messageAnswers.set(SOURCE, () => new Response(null, { status: 503 }));
    else
      (where === "create" ? google.draftCreateAnswers : google.uploadAnswers).push(
        () => new Response(null, { status: 503 }),
      );
    await expectError(
      await sendCall(f, name),
      "google_unavailable",
      where === "read" ? /Google could not complete/ : leftoverMessage,
    );
    expect(await onceRows()).toEqual([]);
    expect(google.sends).toEqual([]);
    expect((await callRows())[0]!.outcome).toBe("failed");
    serveFull();
    await answer(await sendCall(f, name));
    expect(google.sends).toHaveLength(1);
  },
);

it.each([false, true])("an unanswered upload is a known failure, approved %s", async (approved) => {
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
      message: leftoverMessage,
    });
    expect((await row(id))!.outcome).toBe("failed");
    expect(await get(f, id)).toMatchObject({
      status: "failed",
      error: { code: "google_unavailable" },
    });
  } else await expectError((await work) as Response, "google_unavailable", leftoverMessage);
  expect(await onceRows()).toEqual([]);
  expect(google.sends).toEqual([]);
  expect((await callRows())[0]!.outcome).toBe("failed");
  if (id) {
    const next = (await answer(await sendCall(f, "forward_message"))).approval as string;
    expect((await approve(f, next)).state.kind).toBe("succeeded");
  } else await answer(await sendCall(f, "forward_message"));
  expect(google.sends).toHaveLength(1);
});

it.each([400, 404])(
  "a missing forward source (%s) is not_found and can be retried",
  async (status) => {
    const f = await sendFixture("forward_message");
    google.messageAnswers.set(SOURCE, () => new Response(null, { status }));
    await expectError(await sendCall(f, "forward_message"), "not_found", /No message/);
    expect(await onceRows()).toEqual([]);
  },
);

it.each(["bad-data", "missing-data", "404", "padded"])(
  "attachment bytes handle %s without sending bad data",
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
  "%s before send is known and a retry can send",
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
    await expectError(
      await work,
      "google_unavailable",
      kind === "read lost" ? /Google could not complete/ : leftoverMessage,
    );
    expect(await onceRows()).toEqual([]);
    expect(google.sends).toEqual([]);
    expect((await callRows())[0]!.outcome).toBe("failed");
    serveFull();
    await answer(await sendCall(f, name));
    expect(google.sends).toHaveLength(1);
  },
);

it("an attached mail is one file and its inner body and files stay inside it", async () => {
  const f = await sendFixture("forward_message");
  const raw = fullMessage();
  const attached = "From: sam@example.com\r\nSubject: Attached\r\n\r\nInside the attached mail.";
  const mail = {
    ...part("message/rfc822", attached, "1", "original.eml"),
    parts: [
      part("text/plain", "MUST_STAY_INSIDE", "1.0"),
      part("application/pdf", "INNER_FILE", "1.1", "inner.pdf"),
    ],
  };
  raw.payload = {
    ...tree("multipart/mixed", [part("text/plain", "Outer body", "0"), mail]),
    headers: raw.payload.headers,
  };
  serveFull(raw);
  await answer(await sendCall(f, "forward_message"));
  const sent = mime(google.uploads[0]!.message);
  expect(sent.parts).toHaveLength(2);
  expect(new TextDecoder().decode(sent.parts[0]!.data)).toContain("Outer body");
  expect(new TextDecoder().decode(sent.parts[0]!.data)).not.toContain("MUST_STAY_INSIDE");
  expect(sent.parts[1]!.headers["Content-Type"]).toBe("application/octet-stream");
  expect(new TextDecoder().decode(sent.parts[1]!.data)).toBe(attached);
  expect(google.attachmentRequests).toEqual([]);
});

it.each(["cut", "omitted"])(
  "refuses an original whose text is %s before staging or offering Approve",
  async (kind) => {
    const f = await sendFixture("forward_message");
    const raw = fullMessage();
    raw.payload.body =
      kind === "cut"
        ? { size: 1_000_001, data: bytes("x".repeat(1_000_001)) }
        : { size: 2_000_001, attachmentId: "large-body" };
    serveFull(raw);
    await expectError(
      await sendCall(f, "forward_message"),
      "message_too_large",
      "The text of the original message cannot be carried whole: it is too large, or its HTML could not be converted.",
    );
    expect(google.uploads).toEqual([]);
    expect(google.sends).toEqual([]);
    expect(await onceRows()).toEqual([]);
    await setSend(f, "forward_message", "ask");
    const id = (await answer(await sendCall(f, "forward_message"))).approval as string;
    expect((await page(f, id)).state).toMatchObject({ kind: "waiting", shown: false });
  },
);

it("unfolds original headers before quoting or composing a forward", async () => {
  const f = await sendFixture("forward_message");
  serveFull(
    fullMessage({
      From: "Sam <sam@example.com>\nBcc: hidden@example.com",
      Subject: "Lunch\r\nTo: x@example.com",
      To: "Alex <alex.personal@example.com>\nBcc: hidden@example.com",
      Cc: "Kim <kim@example.com>\nTo: forged@example.com",
    }),
  );
  await answer(await sendCall(f, "forward_message"));
  const mail = mime(google.uploads[0]!.message);
  expect(decodeWords(mail.headers.Subject!)).toBe("Fwd: Lunch  To: x@example.com");
  const text = new TextDecoder().decode(mail.parts[0]!.data);
  expect(text).toContain("Subject: Lunch  To: x@example.com\n");
  expect(text).toContain("From: Sam <sam@example.com> Bcc: hidden@example.com\n");
  expect(text.split("\n").filter((line) => /^(To|Cc):/.test(line))).toHaveLength(2);
  expect(text).not.toMatch(/\nBcc:/);
});

it("refuses an alternative that replaces preferred text which did not fit the body budget", async () => {
  const f = await sendFixture("forward_message");
  const raw = fullMessage();
  raw.payload = {
    ...tree("multipart/alternative", [
      tree("multipart/mixed", [
        part("text/plain", "a".repeat(1_100_000), "0.0"),
        part("text/plain", "b".repeat(1_100_000), "0.1"),
      ]),
      part("text/html", "<p>Fallback alternative</p>", "1"),
    ]),
    headers: raw.payload.headers,
  };
  serveFull(raw);
  await expectError(
    await sendCall(f, "forward_message"),
    "message_too_large",
    "The text of the original message cannot be carried whole: it is too large, or its HTML could not be converted.",
  );
  expect(google.uploads).toEqual([]);
  expect(google.sends).toEqual([]);
  expect(await onceRows()).toEqual([]);
});

it.each(["drafts", "upload", "send", "delete"])(
  "the fake refuses an unauthenticated %s write",
  async (operation) => {
    const f = await sendFixture();
    let url = "https://gmail.googleapis.com/gmail/v1/users/me/drafts";
    let method = "POST";
    let body: string | undefined = "{}";
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (operation === "send") {
      url += "/send";
      body = JSON.stringify({ id: "existing-draft" });
    }
    if (operation === "delete") {
      url += "/existing-draft";
      method = "DELETE";
      body = undefined;
    }
    if (operation === "upload") {
      url = "https://gmail.googleapis.com/upload/gmail/v1/users/me/drafts?uploadType=multipart";
      headers["Content-Type"] = "multipart/related; boundary=unauthorized";
      body =
        "--unauthorized\r\nContent-Type: application/json\r\n\r\n{}\r\n--unauthorized\r\nContent-Type: message/rfc822\r\n\r\nSubject: Unauthorized\r\n\r\nBody\r\n--unauthorized--\r\n";
    }
    expect((await fetch(url, { method, headers, body, redirect: "manual" })).status).toBe(401);
    expect(google.storedDrafts.has("existing-draft")).toBe(true);
    await permission(f);
  },
);

it("preserves the charset and bytes of a text attachment without changing its approval line", async () => {
  const f = await sendFixture("forward_message", "ask");
  const raw = fullMessage();
  raw.payload = {
    ...tree("multipart/mixed", [
      part("text/plain", "Body", "0"),
      {
        ...part("text/csv", "", "1", "rows.csv"),
        headers: [
          { name: "Content-Type", value: 'text/csv; name="rows.csv"; CHARSET="ISO-8859-1"' },
        ],
        body: { size: 4, data: "6SwxCg" },
      },
    ]),
    headers: raw.payload.headers,
  };
  serveFull(raw);
  const id = (await answer(await sendCall(f, "forward_message"))).approval as string;
  expect((await page(f, id)).request.values).toContainEqual({
    name: "Attachment 1",
    text: "rows.csv (text/csv, 4 bytes)",
    from: "gmail",
  });
  expect((await approve(f, id)).state.kind).toBe("succeeded");
  const file = mime(google.uploads[0]!.message).parts[1]!;
  expect(file.headers["Content-Type"]).toBe("text/csv; charset=ISO-8859-1");
  expect(file.data).toEqual(new Uint8Array([233, 44, 49, 10]));
});

it.each([400, 413])(
  "allows an upload caller to map a refusal with status %s",
  async (status) => {
    const { Effect, Result } = await import("effect");
    const { ToolFailure } = await import("../src/mcp/failures");
    const { uploadDraft } = await import("../src/google/draft");
    const refused = vi.fn(
      (status: number) =>
        new ToolFailure({ code: "invalid_arguments", said: `Upload refused with ${status}` }),
    );
    const result = await Effect.runPromise(
      Effect.result(
        uploadDraft(
          (build) => {
            build("test-token", new AbortController().signal);
            return Effect.succeed(new Response(null, { status }));
          },
          { message: new Blob(["MIME bytes"]) },
          refused,
        ),
      ),
    );
    expect(refused).toHaveBeenCalledExactlyOnceWith(status);
    expect(Result.isFailure(result) && result.failure).toMatchObject({
      code: "invalid_arguments",
      said: `Upload refused with ${status}`,
    });
  },
);

it("the fake returns 404 when deleting a draft it does not hold", async () => {
  await sendFixture();
  const headers = { Authorization: `Bearer ${token()}` };
  const remove = (id: string) =>
    fetch(`https://gmail.googleapis.com/gmail/v1/users/me/drafts/${id}`, {
      method: "DELETE",
      headers,
    });
  expect((await remove("existing-draft")).status).toBe(204);
  expect(google.storedDrafts.has("existing-draft")).toBe(false);
  expect((await remove("existing-draft")).status).toBe(404);
  expect((await remove("never-held")).status).toBe(404);
});

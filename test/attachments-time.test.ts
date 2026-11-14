import { mime } from "./support/send";
import "./support/account-checks";
import { env } from "cloudflare:workers";
import { expect, it, vi } from "vite-plus/test";
import { attaching, copy, setTool, attachCall, filePart, serveAttachment } from "./support/uploads";
import { google, deferred } from "./support/google";
import { message, part, tree } from "./support/thread";
import { answer, digest, post } from "./support/approvals";
import { serveMessage, SOURCE } from "./support/draft";
import { testEnv } from "./support/worker";
import { expectError, NORTHWIND } from "./support/permissions";
import { NOW } from "./support/accounts";

it("stops a copy at the send reserve before its bytes arrive at sixteen seconds", async () => {
  const f = await attaching();
  await setTool(f, "get_attachment", "allow", f.northwind);
  const raw = serveAttachment({ ...filePart(), body: { size: 8, attachmentId: "slow" } });
  const reading = deferred();
  const bytes = deferred();
  google.messageAnswers.set(copy.message, async () => {
    reading.resolve();
    await new Promise((resolve) => setTimeout(resolve, 6_000));
    return Response.json(raw);
  });
  google.attachmentAnswers.set("slow", (request) => {
    bytes.resolve();
    return new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => resolve(Response.json({ data: "AP_-AYANCkE" })), 10_000);
      request.signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(request.signal.reason);
        },
        { once: true },
      );
    });
  });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const work = attachCall(f, [copy]);
  await reading.promise;
  vi.mocked(Date.now).mockReturnValue(NOW + 6_000);
  await vi.advanceTimersByTimeAsync(6_000);
  await bytes.promise;
  vi.mocked(Date.now).mockReturnValue(NOW + 15_000);
  await vi.advanceTimersByTimeAsync(9_000);
  await expectError(
    await work,
    "google_unavailable",
    `Google could not complete the request for ${NORTHWIND}. Try again later.`,
  );
  expect(google.uploads).toEqual([]);
  expect(google.sends).toEqual([]);
});
it("ends approval source reads at the reserve including time spent reading the reply", async () => {
  const f = await attaching("send_reply", "ask");
  await setTool(f, "get_attachment", "allow", f.northwind);
  serveMessage();
  const reply = google.messageAnswers.get(SOURCE)!;
  const reading = deferred();
  const source = deferred();
  google.messageAnswers.set(SOURCE, async (request) => {
    reading.resolve();
    await new Promise((resolve) => setTimeout(resolve, 6_000));
    return reply(request);
  });
  google.messageAnswers.set(copy.message, (request) => {
    source.resolve();
    return new Promise<Response>((_resolve, reject) =>
      request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true }),
    );
  });
  const id = (await answer(await attachCall(f, [copy], { message: SOURCE }, "send_reply")))
    .approval as string;
  const { page } = await import("./support/approvals");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const work = page(f, id);
  await reading.promise;
  vi.mocked(Date.now).mockReturnValue(NOW + 6_000);
  await vi.advanceTimersByTimeAsync(6_000);
  await source.promise;
  vi.mocked(Date.now).mockReturnValue(NOW + 15_000);
  await vi.advanceTimersByTimeAsync(9_000);
  expect((await work).state).toMatchObject({ kind: "waiting", shown: false });
  expect(google.uploads).toEqual([]);
  expect(google.sends).toEqual([]);
});

it.each(["expired token", "first read 401"])(
  "bounds six concurrent copies and refreshes once per account with %s",
  async (refresh) => {
    const f = await attaching("send_message", "ask");
    await setTool(f, "get_attachment", "allow", f.northwind);
    const copies = Array.from({ length: 6 }, (_, i) => ({
      ...copy,
      message: `copy-${i}`,
      attachment: "1",
    }));
    let active = 0;
    let peak = 0;
    let completed = 0;
    let unauthorized = refresh === "first read 401";
    const delayed = async (response: Response) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      active--;
      completed++;
      return response;
    };
    for (const [i, item] of copies.entries()) {
      const raw = {
        ...message(item.message),
        payload: {
          ...tree("multipart/mixed", [
            {
              ...part("application/pdf", "", "1", `file-${i}.pdf`),
              body: { size: 1, attachmentId: `bytes-${i}` },
            },
          ]),
          headers: message().payload.headers,
        },
      };
      google.messageAnswers.set(item.message, () => {
        if (unauthorized) {
          unauthorized = false;
          return delayed(new Response(null, { status: 401 }));
        }
        return delayed(Response.json(raw));
      });
      google.attachmentAnswers.set(`bytes-${i}`, () => delayed(Response.json({ data: "AA" })));
    }
    const id = (await answer(await attachCall(f, copies))).approval as string;
    if (refresh === "expired token")
      await env.DB.prepare("UPDATE accounts SET access_expires_at = 1 WHERE id = ?")
        .bind(f.northwind.id)
        .run();
    const { page } = await import("./support/approvals");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const drive = async <A>(work: Promise<A>, expected: number) => {
      let settled = false;
      const result = work.finally(() => {
        settled = true;
      });
      let elapsed = 0;
      while (!settled && elapsed < 14_000) {
        await vi.waitFor(() => expect(active > 0 || settled).toBe(true));
        vi.mocked(Date.now).mockReturnValue(NOW + elapsed + 1_000);
        await vi.advanceTimersByTimeAsync(1_000);
        elapsed += 1_000;
      }
      expect(completed).toBe(expected);
      expect(elapsed).toBeLessThan(10_000);
      return result;
    };
    const before = google.refreshTokens.length;
    expect((await drive(page(f, id), refresh === "expired token" ? 6 : 7)).state).toMatchObject({
      kind: "waiting",
      shown: true,
    });
    expect(google.refreshTokens.length - before).toBe(1);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(5);
    expect(vi.getTimerCount()).toBe(0);
    await setTool(f, "send_message", "allow");
    // A different body runs directly rather than repeating the waiting approval.
    if (refresh === "expired token")
      await env.DB.prepare("UPDATE accounts SET access_expires_at = 1 WHERE id = ?")
        .bind(f.northwind.id)
        .run();
    unauthorized = refresh === "first read 401";
    completed = 0;
    peak = 0;
    vi.mocked(Date.now).mockReturnValue(NOW);
    const again = google.refreshTokens.length;
    await answer(
      await drive(
        attachCall(f, copies, { body: "Direct copies" }),
        refresh === "expired token" ? 12 : 13,
      ),
    );
    expect(google.refreshTokens.length - again).toBe(1);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(5);
    expect(google.sends).toHaveLength(1);
    expect(mime(google.uploads[0]!.message).parts).toHaveLength(7);
    expect(vi.getTimerCount()).toBe(0);
  },
);
it("bounds uploaded byte reads by the direct call's reserve and releases its identity", async () => {
  const f = await attaching();
  const { upload, uploads, noWrites } = await import("./support/uploads");
  const { onceRows } = await import("./support/draft");
  const local = await upload(f);
  const reading = deferred();
  const files = new Proxy(env.FILES_KV, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key);
      if (key === "get")
        return async (...args: unknown[]) => {
          reading.resolve();
          await new Promise((resolve) => setTimeout(resolve, 40_000));
          return Reflect.apply(value as (...args: unknown[]) => unknown, target, args);
        };
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const work = attachCall(
    f,
    [{ upload: local.upload }],
    {},
    "send_message",
    testEnv({ FILES_KV: files }),
  );
  await reading.promise;
  vi.mocked(Date.now).mockReturnValue(NOW + 15_000);
  await vi.advanceTimersByTimeAsync(15_000);
  await expectError(
    await work,
    "upload_not_ready",
    "The server cannot read the uploaded file yet. Call again with the same arguments in one minute.",
  );
  expect(await onceRows()).toEqual([]);
  expect(await uploads()).toHaveLength(1);
  expect(await env.DB.prepare("SELECT identity FROM uploads").first()).toEqual({ identity: null });
  noWrites();
  vi.mocked(Date.now).mockReturnValue(NOW + 40_000);
  await vi.advanceTimersByTimeAsync(25_000);
});
it("keeps approval arguments when uploaded bytes arrive after its reserve", async () => {
  const f = await attaching("send_message", "ask");
  const { upload, noWrites } = await import("./support/uploads");
  const { row } = await import("./support/approvals");
  const local = await upload(f);
  const id = (await answer(await attachCall(f, [{ upload: local.upload }]))).approval as string;
  const shown = await digest(f, id);
  const reading = deferred();
  const files = new Proxy(env.FILES_KV, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key);
      if (key === "get")
        return async (...args: unknown[]) => {
          reading.resolve();
          await new Promise((resolve) => setTimeout(resolve, 21_000));
          return Reflect.apply(value as (...args: unknown[]) => unknown, target, args);
        };
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const work = post(f, id, "approve", { digest: shown }, testEnv({ FILES_KV: files }));
  await reading.promise;
  vi.mocked(Date.now).mockReturnValue(NOW + 21_000);
  await vi.advanceTimersByTimeAsync(21_000);
  expect((await work).status).toBe(503);
  expect(await row(id)).toMatchObject({ state: "waiting", arguments: expect.any(String) });
  noWrites();
});

it("keeps a send_draft approval waiting when its view reaches the decision after the reserve", async () => {
  const { sendFixture, sendCall } = await import("./support/send");
  const { row } = await import("./support/approvals");
  const { onceRows } = await import("./support/draft");
  const f = await sendFixture("send_draft", "ask");
  const id = (await answer(await sendCall(f, "send_draft"))).approval as string;
  const shown = await digest(f, id);
  google.fullDraftAnswers.set("existing-draft", () => {
    vi.mocked(Date.now).mockReturnValue(NOW + 21_000);
    return Response.json({
      id: "existing-draft",
      message: google.storedDrafts.get("existing-draft"),
    });
  });
  expect((await post(f, id, "approve", { digest: shown })).status).toBe(503);
  expect(await row(id)).toMatchObject({ state: "waiting", arguments: expect.any(String) });
  expect(await onceRows()).toEqual([]);
  expect(google.sends).toEqual([]);
});

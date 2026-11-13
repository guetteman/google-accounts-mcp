import { mime } from "./support/send";
import "./support/account-checks";
import { env } from "cloudflare:workers";
import { expect, it, vi } from "vite-plus/test";
import {
  attaching,
  copy,
  setTool,
  attachCall,
  watchedFiles,
  filePart,
  serveAttachment,
  fileOf,
} from "./support/uploads";
import { google, deferred } from "./support/google";
import { message, part, tree } from "./support/thread";
import { answer, digest, post, decided } from "./support/approvals";
import { serveMessage, SOURCE } from "./support/draft";
import { testEnv } from "./support/worker";
import { expectError, NORTHWIND } from "./support/permissions";
import { NOW } from "./support/accounts";
import { requests } from "./support/network";

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
it("starts ten copies together in the page and run and stays below fifty subrequests at Approve", async () => {
  const f = await attaching("send_reply", "ask");
  await setTool(f, "get_attachment", "allow", f.northwind);
  serveMessage();
  const copies = Array.from({ length: 10 }, (_, i) => ({
    ...copy,
    message: `copy-${i}`,
    attachment: "1",
  }));
  const started: number[] = [];
  const bytesStarted: number[] = [];
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
    google.messageAnswers.set(item.message, async () => {
      started.push(Date.now());
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      return Response.json(raw);
    });
    google.attachmentAnswers.set(`bytes-${i}`, async () => {
      bytesStarted.push(Date.now());
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      return Response.json({ data: "AA" });
    });
  }
  const id = (await answer(await attachCall(f, copies, { message: SOURCE }, "send_reply")))
    .approval as string;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const first = digest(f, id);
  await vi.waitFor(() => expect(started).toHaveLength(10));
  expect(new Set(started).size).toBe(1);
  vi.mocked(Date.now).mockReturnValue(Date.now() + 1_000);
  await vi.advanceTimersByTimeAsync(1_000);
  const shown = await first;
  // Both accounts need a refresh in the measured POST. Its view and run share no credentials.
  await env.DB.prepare("UPDATE accounts SET access_expires_at = 1").run();
  started.length = 0;
  let d1 = 0;
  const { observeStatements } = await import("./support/db");
  let statements = 0;
  const observed = observeStatements(env.DB, () => {
    statements++;
  });
  const batchDb = new Proxy(observed, {
    get(target, key) {
      if (key === "batch")
        return (batch: D1PreparedStatement[]) => {
          d1++;
          return target.batch(batch);
        };
      const value: unknown = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  // Standalone reads/writes are counted by the observer; batch statements are subtracted below.
  let batchStatements = 0;
  const measuredDb = new Proxy(batchDb, {
    get(target, key) {
      if (key === "batch")
        return (batch: D1PreparedStatement[]) => {
          batchStatements += batch.length;
          return target.batch(batch);
        };
      const value: unknown = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const watched = watchedFiles();
  const beforeRequests = requests.length;
  const beforeRefresh = google.refreshTokens.length;
  const work = post(
    f,
    id,
    "approve",
    { digest: shown },
    testEnv({ DB: measuredDb, FILES_KV: watched.files }),
  );
  await vi.waitFor(() => expect(started).toHaveLength(10));
  expect(new Set(started).size).toBe(1);
  vi.mocked(Date.now).mockReturnValue(Date.now() + 1_000);
  await vi.advanceTimersByTimeAsync(1_000);
  await vi.waitFor(() => expect(started).toHaveLength(20));
  expect(new Set(started.slice(10)).size).toBe(1);
  vi.mocked(Date.now).mockReturnValue(Date.now() + 1_000);
  await vi.advanceTimersByTimeAsync(1_000);
  await vi.waitFor(() => expect(bytesStarted).toHaveLength(10));
  expect(new Set(bytesStarted).size).toBe(1);
  vi.mocked(Date.now).mockReturnValue(Date.now() + 1_000);
  await vi.advanceTimersByTimeAsync(1_000);
  expect((await decided(await work)).state.kind).toBe("succeeded");
  const count =
    d1 + statements - batchStatements + requests.length - beforeRequests + watched.reads.length;
  expect(google.refreshTokens.length - beforeRefresh).toBe(2);
  expect(count).toBeLessThanOrEqual(50);
  expect(google.sends).toHaveLength(1);
  const mail = mime(google.uploads[0]!.message);
  expect(mail.parts).toHaveLength(11);
  expect(mail.parts.slice(1).map(fileOf)).toEqual(
    Array.from({ length: 10 }, (_, i) => ({
      filename: `file-${i}.pdf`,
      type: "application/pdf",
      bytes: new Uint8Array([0]),
    })),
  );
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

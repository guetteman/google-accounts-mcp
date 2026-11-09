import { describe, expect, it } from "vite-plus/test";
import { Browser } from "./support/browser";
import { dump, writeRecordingDb } from "./support/db";
import { access } from "./support/access";
import { prepareWrites, WRITE_PATH } from "./support/page-app";
import { callWorker, location, ORIGIN, testEnv } from "./support/worker";

const oversized = new TextEncoder().encode(`value=${"a".repeat(64 * 1024)}`);

describe("page request body limits", () => {
  it.each([
    ["with Content-Length", { "Content-Length": String(oversized.byteLength) }],
    ["chunked without Content-Length", { "Transfer-Encoding": "chunked" }],
    ["with a false Content-Length", { "Content-Length": "1" }],
  ])(
    "rejects an oversized body %s before reading it all or writing to D1",
    async (_label, sizeHeaders) => {
      await prepareWrites();
      const owner = new Browser();
      await owner.authenticate();
      const watched = writeRecordingDb();
      const before = await dump();
      let sent = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent === oversized.byteLength) {
            controller.close();
            return;
          }
          const chunk = oversized.subarray(sent, sent + 1024);
          sent += chunk.byteLength;
          controller.enqueue(chunk);
        },
      });
      const headers = new Headers(sizeHeaders);
      headers.set("Origin", ORIGIN);
      headers.set("Content-Type", "application/x-www-form-urlencoded");
      headers.set("Cf-Access-Jwt-Assertion", owner.assertion!);
      const response = await callWorker(
        new Request(`${ORIGIN}${WRITE_PATH}`, { method: "POST", headers, body }),
        testEnv({ DB: watched.db }),
      );
      expect(response.status).toBe(413);
      expect(sent).toBeLessThan(oversized.byteLength);
      expect(location(response)).toBeNull();
      expect(response.headers.getSetCookie()).toEqual([]);
      expect(watched.writes).toEqual([]);
      expect(await dump()).toEqual(before);
      expect(access.requests).toEqual([]);
      expect((await owner.post(WRITE_PATH, { value: "small" })).status).toBe(200);
    },
  );
});

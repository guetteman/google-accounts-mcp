import { describe, expect, it } from "vite-plus/test";
import { Browser } from "./support/browser";
import { dump, writeRecordingDb } from "./support/db";
import { google } from "./support/google";
import { callWorker, location, ORIGIN, testEnv } from "./support/worker";

const oversized = new TextEncoder().encode(`next=${"a".repeat(64 * 1024)}`);

describe("page request body limits", () => {
  it.each([
    ["with Content-Length", { "Content-Length": String(oversized.byteLength) }],
    ["chunked without Content-Length", { "Transfer-Encoding": "chunked" }],
    ["with a false Content-Length", { "Content-Length": "1" }],
  ])(
    "rejects an oversized form %s before reading it all or writing to D1",
    async (_label, sizeHeaders) => {
      const owner = new Browser();
      await owner.signInAsOwner();
      const watched = writeRecordingDb();
      const before = await dump();

      // The shared guard must also run before sibling routes touch or delete a session.
      for (const path of ["/signin", "/signout", "/signout/all"]) {
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
        // The vulnerable sign-in is anonymous; the sign-out requests have a valid session.
        if (path !== "/signin") headers.set("Cookie", `__Host-session=${owner.session}`);
        const request = new Request(`${ORIGIN}${path}`, { method: "POST", headers, body });
        expect(request.headers.get("Content-Length")).toBe(headers.get("Content-Length"));

        const response = await callWorker(request, testEnv({ DB: watched.db }));

        expect(response.status, path).toBe(413);
        expect(sent, path).toBeLessThan(oversized.byteLength);
        expect(location(response), path).toBeNull();
        expect(response.headers.getSetCookie(), path).toEqual([]);
        expect(watched.writes, path).toEqual([]);
        expect(await dump(), path).toEqual(before);
      }
      expect(google.tokenRequests).toEqual([]);

      // A form with the longest return path still completes sign-in after URL encoding.
      const prefix = "/accounts?q=";
      const next = prefix + "&".repeat(1024 - prefix.length);
      const visitor = new Browser();
      const response = await visitor.signIn({}, next);
      expect(response.status).toBe(302);
      expect(location(response)).toBe(next);
      expect(visitor.session).toBeDefined();
    },
  );
});

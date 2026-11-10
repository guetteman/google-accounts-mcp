import { expect, it, vi } from "vite-plus/test";
import { HttpResponse } from "msw";
import "./support/account-checks";
import { google, deferred } from "./support/google";
import {
  callRows,
  expectError,
  fixture,
  permission,
  PERSONAL,
  unavailableMessage,
  toolCall,
} from "./support/permissions";
import { rpcResult } from "./support/oauth";

it.each(["headers", "body"])(
  "ends a Gmail request after ten seconds while waiting for its %s",
  async (stage) => {
    const f = await fixture();
    await permission(f);
    const entered = deferred();
    google.labelAnswers.push((request) => {
      entered.resolve();
      if (stage === "headers")
        return new Promise<Response>((_resolve, reject) => {
          request.signal.addEventListener("abort", () => reject(request.signal.reason), {
            once: true,
          });
        });
      return new HttpResponse(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"labels":['));
            request.signal.addEventListener(
              "abort",
              () => controller.error(request.signal.reason),
              { once: true },
            );
          },
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let settled = false;
    const call = toolCall(f.mcp, "list_labels", { account: PERSONAL }).then(rpcResult);
    void call.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.race([
      entered.promise,
      call.then(() => {
        throw new Error("Call finished before requesting Gmail");
      }),
    ]);
    await vi.advanceTimersByTimeAsync(9999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await call).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            code: "google_unavailable",
            message: unavailableMessage(PERSONAL),
          }),
        },
      ],
    });
    expect(await callRows()).toEqual([
      expect.objectContaining({ account_id: f.personal.id, outcome: null }),
    ]);
  },
);

it("leaves the outcome unknown when Gmail drops the response body after its headers", async () => {
  const f = await fixture();
  await permission(f);
  google.labelAnswers.push(
    () =>
      new HttpResponse(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"labels":['));
            controller.error(new Error("body connection lost"));
          },
        }),
      ),
  );
  await expectError(
    await toolCall(f.mcp, "list_labels", { account: PERSONAL }),
    "google_unavailable",
    unavailableMessage(PERSONAL),
  );
  expect(await callRows()).toEqual([expect.objectContaining({ outcome: null })]);
});

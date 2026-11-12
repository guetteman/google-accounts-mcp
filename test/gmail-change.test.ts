import { Effect, Result, Schema } from "effect";
import { expect, it, vi } from "vite-plus/test";
import { change } from "../src/google/gmail";
import { ToolFailure } from "../src/mcp/failures";
import type { Send } from "../src/mcp/tools";

const Answer = Schema.Struct({ id: Schema.String });
const refused = () => new ToolFailure({ code: "not_found" });
const reply =
  (response: Response): Send =>
  (build) => {
    build("test-token", new AbortController().signal);
    return Effect.succeed(response);
  };

it.each(["POST", "PUT", "DELETE"] as const)(
  "builds an authorized %s request with JSON only when a body is supplied",
  async (method) => {
    for (const body of [undefined, { addLabelIds: ["STARRED"] }, null]) {
      const controller = new AbortController();
      let request: Request | undefined;
      const send: Send = (build) => {
        request = build("test-token", controller.signal);
        return Effect.succeed(Response.json({ id: "m1" }));
      };
      await Effect.runPromise(change(send, method, "messages/m1/modify", Answer, refused, body));
      expect(request!.url).toBe(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages/m1/modify",
      );
      expect(request!.method).toBe(method);
      expect(request!.headers.get("Authorization")).toBe("Bearer test-token");
      expect(request!.redirect).toBe("manual");
      expect(request!.signal.aborted).toBe(false);
      controller.abort();
      expect(request!.signal.aborted).toBe(true);
      if (body === undefined) {
        expect(request!.body).toBeNull();
        expect(request!.headers.has("Content-Type")).toBe(false);
      } else {
        expect(request!.headers.get("Content-Type")).toBe("application/json");
        expect(await request!.text()).toBe(JSON.stringify(body));
      }
    }
  },
);

it("decodes a successful JSON response with its schema", async () => {
  const schema = Schema.Struct({ id: Schema.NumberFromString });
  expect(
    await Effect.runPromise(
      change(
        reply(Response.json({ id: "42" }, { status: 201 })),
        "POST",
        "messages",
        schema,
        refused,
      ),
    ),
  ).toEqual({ id: 42 });
});

it.each(["unreadable", "invalid JSON", "wrong schema"])(
  "keeps the outcome unknown after a successful response with an %s body",
  async (body) => {
    const response =
      body === "unreadable"
        ? new Response(
            new ReadableStream({
              start(controller) {
                controller.error(new Error("lost response"));
              },
            }),
          )
        : body === "invalid JSON"
          ? new Response("not JSON")
          : Response.json({ id: 42 });
    const result = await Effect.runPromise(
      Effect.result(change(reply(response), "POST", "messages", Answer, refused)),
    );
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { code: "google_unavailable", unknown: true },
    });
  },
);

it("accepts 204 without reading a body when there is no schema", async () => {
  const response = new Response(null, { status: 204 });
  const text = vi.spyOn(response, "text");
  expect(
    await Effect.runPromise(change(reply(response), "DELETE", "messages/m1", null, refused)),
  ).toBeUndefined();
  expect(text).not.toHaveBeenCalled();
});

it.each([404, 429])("passes a %s refusal through unchanged", async (status) => {
  const failure = new ToolFailure({ code: "not_found", missing: { kind: "message", id: "m1" } });
  const refuse = vi.fn(() => failure);
  const result = await Effect.runPromise(
    Effect.result(
      change(reply(new Response(null, { status })), "DELETE", "messages/m1", null, refuse),
    ),
  );
  expect(refuse).toHaveBeenCalledExactlyOnceWith(status);
  expect(Result.isFailure(result) && result.failure).toBe(failure);
});

it.each([302, 503])("keeps the outcome unknown for status %s", async (status) => {
  const refuse = vi.fn(refused);
  const result = await Effect.runPromise(
    Effect.result(
      change(reply(new Response(null, { status })), "DELETE", "messages/m1", null, refuse),
    ),
  );
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: { code: "google_unavailable", unknown: true },
  });
  expect(refuse).not.toHaveBeenCalled();
});

it.each([
  new ToolFailure({ code: "account_needs_reconnect" }),
  new ToolFailure({ code: "google_unavailable", unknown: true }),
])("preserves a send failure of $code with unknown=$unknown", async (failure) => {
  const send: Send = () => Effect.fail(failure);
  const result = await Effect.runPromise(
    Effect.result(change(send, "POST", "messages", Answer, refused)),
  );
  expect(Result.isFailure(result) && result.failure).toBe(failure);
});

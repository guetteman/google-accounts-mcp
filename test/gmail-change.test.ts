import { Effect, Schema } from "effect";
import { expect, it } from "vite-plus/test";
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

// Production sends a JSON body only with POST; DELETE carries no body.
it.each([
  { method: "POST", body: { addLabelIds: ["STARRED"] } },
  { method: "DELETE", body: undefined },
] as const)(
  "builds an authorized $method request with JSON only when a body is supplied",
  async ({ method, body }) => {
    const controller = new AbortController();
    let request: Request | undefined;
    const send: Send = (build) => {
      request = build("test-token", controller.signal);
      return Effect.succeed(Response.json({ id: "m1" }));
    };
    await Effect.runPromise(change(send, method, "messages/m1/modify", Answer, refused, body));
    expect(request!.url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/messages/m1/modify");
    expect(request!.method).toBe(method);
    expect(request!.headers.get("Authorization")).toBe("Bearer test-token");
    expect(request!.redirect).toBe("manual");
    controller.abort();
    expect(request!.signal.aborted).toBe(true);
    if (body === undefined) {
      expect(request!.body).toBeNull();
      expect(request!.headers.has("Content-Type")).toBe(false);
    } else {
      expect(request!.headers.get("Content-Type")).toBe("application/json");
      expect(await request!.text()).toBe(JSON.stringify(body));
    }
  },
);

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

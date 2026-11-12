import { env } from "cloudflare:workers";
import { Effect, Result } from "effect";
import { expect, it } from "vite-plus/test";
import "./support/account-checks";
import { accountRequests } from "../src/mcp/call";
import { readConfig } from "../src/config";
import { readOwner } from "../src/owner/owner";
import { credential, NOW, seedAccount } from "./support/accounts";
import { google, LABELS_URL, token } from "./support/google";
import { testEnv } from "./support/worker";

const DEADLINE = NOW + 20_000;
const build = (token: string, signal: AbortSignal) =>
  new Request(LABELS_URL, { headers: { Authorization: `Bearer ${token}` }, signal });

const requestsAt = async (now: () => number, signal?: AbortSignal) => {
  const row = await seedAccount();
  const config = readConfig(testEnv());
  if (Result.isFailure(config)) throw new Error("Invalid test config");
  const owner = await Effect.runPromise(readOwner(env.DB));
  return accountRequests(
    {
      db: env.DB,
      config: config.success,
      owner: { generation: owner.generation, email: owner.email! },
      now,
    },
    { credential: await credential(row.id), status: { kind: "ready" } },
    DEADLINE,
    signal,
  );
};

it("keeps an earlier result when the next request starts after the call's deadline", async () => {
  let now = NOW;
  const requests = await requestsAt(() => now);
  google.labelAnswers.push(() => Response.json({ id: "first" }));
  try {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const response = yield* requests.send(build);
        const first = yield* Effect.promise(() => response.json<{ id: string }>());
        now = DEADLINE;
        const next = yield* Effect.result(requests.send(build));
        return { first, next };
      }),
    );
    expect(result.first).toEqual({ id: "first" });
    expect(result.next).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "ToolFailure", code: "google_unavailable", unknown: true },
    });
    expect(google.labelRequests).toHaveLength(1);
  } finally {
    requests.close();
  }
});

it.each([
  { cut: "deadline", retry: false },
  { cut: "aborted signal", retry: false },
  { cut: "deadline", retry: true },
  { cut: "aborted signal", retry: true },
])("returns an ordinary failure for $cut with a 401 retry=$retry", async ({ cut, retry }) => {
  let now = NOW;
  const controller = new AbortController();
  const requests = await requestsAt(() => now, controller.signal);
  const stop = () => {
    if (cut === "deadline") now = DEADLINE;
    else controller.abort();
  };
  if (retry) {
    google.labelAnswers.push(() => new Response(null, { status: 401 }));
    google.refreshAnswers.push(async () => {
      stop();
      return Response.json({ access_token: token(), expires_in: 3600 });
    });
  } else stop();
  try {
    const result = await Effect.runPromise(Effect.result(requests.send(build)));
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "ToolFailure", code: "google_unavailable", unknown: true },
    });
    expect(google.labelRequests).toHaveLength(retry ? 1 : 0);
    expect(google.events).toEqual(retry ? ["refresh"] : []);
  } finally {
    requests.close();
  }
});

import { expect, it, vi } from "vite-plus/test";
import { http, HttpResponse } from "msw";
import { recordedConsole } from "./support/account-checks";
import { accounts, call, finish, NOW, ownerBrowser, seedAccount, start } from "./support/accounts";
import { dump } from "./support/db";
import { google, deferred, type Answer } from "./support/google";
import { network } from "./support/network";
import { testEnv, textOf } from "./support/worker";

const DOWN = "Google didn't answer. Nothing changed. Try again in a minute.";
const failures: Array<[string, Answer]> = [
  ["JSON 429", { status: 429, body: JSON.stringify({ error: "invalid_grant" }) }],
  ["JSON 503", { status: 503, body: JSON.stringify({ error: "invalid_grant" }) }],
  ["malformed 200", { status: 200, body: "not-json" }],
];

it.each(failures)(
  "treats an exchange response of %s as unavailable without storing an account",
  async (_label, answer) => {
    const b = await ownerBrowser();
    google.exchangeAnswer = answer;
    const result = await finish(b, (await start(b)).url);
    expect(result.text).toContain(DOWN);
    expect(await accounts()).toEqual([]);
  },
);

it.each(failures)(
  "treats a refresh response of %s as unavailable without changing credentials",
  async (_label, answer) => {
    const row = await seedAccount({ access_expires_at: NOW });
    const before = await dump();
    google.refreshAnswers = [answer];
    expect(await call(row.id)).toMatchObject({ error: "GoogleUnavailable" });
    expect(await dump()).toEqual(before);
    expect(google.events).toEqual(["refresh"]);
  },
);

it.each([302, 307])(
  "never follows a token endpoint redirect with status %s during exchange or refresh",
  async (status) => {
    let followed = 0;
    network.use(
      http.all("https://redirect.example/token", () => {
        followed++;
        return HttpResponse.json({ error: "unavailable" }, { status: 503 });
      }),
    );
    const redirect = {
      status,
      body: "{}",
      headers: { Location: "https://redirect.example/token" },
    };
    const b = await ownerBrowser();
    google.exchangeAnswer = redirect;
    expect((await finish(b, (await start(b)).url)).text).toContain(DOWN);
    expect(await accounts()).toEqual([]);
    const row = await seedAccount({ access_expires_at: NOW });
    const before = await dump();
    google.refreshAnswers = [redirect];
    expect(await call(row.id)).toMatchObject({ error: "GoogleUnavailable" });
    expect(await dump()).toEqual(before);
    expect(followed).toBe(0);
    // MSW rejects redirects of POST bodies before following; also verify the fetch policy.
    expect(google.tokenRedirects).toEqual(["manual", "manual"]);
    expect(google.events).toEqual(["exchange", "refresh"]);
  },
);

it("refuses an empty access token from both exchange and refresh", async () => {
  const b = await ownerBrowser();
  expect((await finish(b, (await start(b)).url, { accessToken: "" })).text).toContain(DOWN);
  expect(await accounts()).toEqual([]);
  const row = await seedAccount({ access_expires_at: NOW });
  const before = await dump();
  google.refreshAnswers = [
    { status: 200, body: JSON.stringify({ access_token: "", expires_in: 3600 }) },
  ];
  expect(await call(row.id)).toMatchObject({ error: "GoogleUnavailable" });
  expect(await dump()).toEqual(before);
  expect(google.events).toEqual(["exchange", "refresh"]);
});

it("names refused OAuth client settings and logs no secret", async () => {
  const b = await ownerBrowser();
  google.exchangeAnswer = "invalid_client";
  expect((await finish(b, (await start(b)).url)).text).toContain(
    "Google refused this server's OAuth client. Check GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET. Nothing changed.",
  );
  expect(await accounts()).toEqual([]);
  const row = await seedAccount({ access_expires_at: NOW });
  const before = await dump();
  google.refreshAnswers = ["invalid_client"];
  expect(await call(row.id)).toMatchObject({ error: "GoogleUnavailable" });
  expect(await dump()).toEqual(before);
  expect(recordedConsole()).toEqual([
    ["Google OAuth client credentials were refused"],
    ["Google OAuth client credentials were refused"],
  ]);
  expect(JSON.stringify(recordedConsole())).not.toContain(testEnv().GOOGLE_CLIENT_SECRET);
});

it("accepts only refresh tokens issued by the Google test server", async () => {
  const request = (refresh: string) =>
    fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refresh,
        client_id: testEnv().GOOGLE_CLIENT_ID,
        client_secret: testEnv().GOOGLE_CLIENT_SECRET,
      }),
    });
  const rejected = await request("unissued-refresh-token");
  expect(rejected.status).toBe(400);
  expect(await rejected.json()).toEqual({ error: "invalid_grant" });
  const accepted = await request(google.issueRefreshToken());
  expect(accepted.status).toBe(200);
  expect(await accepted.json()).toMatchObject({ access_token: google.issuedAccess.at(-1) });
});

it.each([302, 307])(
  "refuses a revoke redirect with status %s and removes local access without following it",
  async (status) => {
    let followed = 0;
    network.use(
      http.all("https://redirect.example/revoke", () => {
        followed++;
        return new HttpResponse(null, { status: 200 });
      }),
    );
    google.revokeAnswer = {
      status,
      body: "",
      headers: { Location: "https://redirect.example/revoke" },
    };
    const row = await seedAccount();
    const b = await ownerBrowser();
    expect(await (await b.post(`/accounts/${row.id}/remove`, { disconnect: "1" })).json()).toEqual({
      outcome: "ok",
    });
    expect((await accounts())[0]).toMatchObject({
      state: "removed",
      refresh_token: null,
      access_token: null,
    });
    expect(textOf(await (await b.get("/accounts")).text())).toContain(
      "Google didn't confirm the disconnect.",
    );
    // MSW rejects redirects of POST bodies before following; also verify the fetch policy.
    expect(google.revokeRedirects).toEqual(["manual"]);
    expect(followed).toBe(0);
    expect(google.events).toEqual(["revoke"]);
  },
);

it.each(["exchange", "refresh"])(
  "times out the %s whose response body stalls after its headers",
  async (action) => {
    const b = await ownerBrowser();
    const row = action === "refresh" ? await seedAccount({ access_expires_at: NOW }) : null;
    const url = action === "exchange" ? (await start(b)).url : null;
    const entered = deferred();
    let body!: ReadableStreamDefaultController<Uint8Array>;
    const stalled: Answer = async (signal) =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            body = controller;
            signal.addEventListener("abort", () => controller.error(new Error("aborted")), {
              once: true,
            });
            entered.resolve();
          },
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    if (action === "refresh") google.refreshAnswers = [stalled];
    else google.exchangeAnswer = stalled;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let settled = false;
    const pending = (row ? call(row.id) : finish(b, url!)).then((result) => {
      settled = true;
      return result;
    });
    try {
      await entered.promise;
      await vi.advanceTimersByTimeAsync(9999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      // Give the Worker response stream and D1 their normal asynchronous turns.
      await vi.waitFor(() => expect(settled).toBe(true));
      const result = await pending;
      if (row) expect(result).toMatchObject({ error: "GoogleUnavailable" });
      else expect(result).toMatchObject({ text: expect.stringContaining(DOWN) });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      body?.error(new Error("test cleanup"));
      vi.useRealTimers();
      await pending;
    }
  },
);

it.each(["ok", { status: 200, body: "invalid-json" }] as Answer[])(
  "clears the token deadline after a completed response: %j",
  async (answer) => {
    const row = await seedAccount({ access_expires_at: NOW });
    google.refreshAnswers = [answer];
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      expect(await call(row.id)).toMatchObject(
        answer === "ok" ? { status: 200 } : { error: "GoogleUnavailable" },
      );
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  },
);

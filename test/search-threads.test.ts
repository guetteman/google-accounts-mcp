import { expect, it } from "vite-plus/test";
import { HttpResponse } from "msw";
import "./support/account-checks";
import { fixtureOpen } from "./support/accounts";
import { google, THREAD_LINES, THREAD_LIST, THREADS_URL } from "./support/google";
import { McpClient, rpcResult } from "./support/oauth";
import {
  callRows,
  expectError,
  fixture,
  googleTraffic,
  permission,
  PERSONAL,
  refusedMessage,
  textResult,
  toolCall,
  unavailableMessage,
} from "./support/permissions";

// The search tool through the Worker's MCP endpoint, with Gmail's answers in the shapes that
// a real account returned (issue #23).
const search = (f: { mcp: McpClient }, args: Record<string, unknown>) =>
  toolCall(f.mcp, "search_threads", { account: PERSONAL, ...args });
const allowed = async () => {
  const f = await fixture();
  await permission(f, f.personal, true, "search_threads");
  return f;
};
const METADATA = "?format=metadata&metadataHeaders=Subject&metadataHeaders=From";

it("returns each thread's subject, sender, date, snippet as text, message count and unread flag, in Gmail's order", async () => {
  const f = await allowed();
  expect(await rpcResult(await search(f, { query: "in:inbox is:unread" }))).toEqual(
    textResult({
      account: PERSONAL,
      threads: THREAD_LINES,
      next_page: THREAD_LIST.nextPageToken,
    }),
  );
  const token = `Bearer ${await fixtureOpen(`${f.personal.id}:access`, f.personal.access_token!)}`;
  expect(google.threadRequests[0]).toEqual({
    url: `${THREADS_URL}?q=in%3Ainbox+is%3Aunread&maxResults=10`,
    authorization: token,
    redirect: "manual",
  });
  expect(
    google.threadRequests
      .slice(1)
      .map((r) => r.url)
      .sort(),
  ).toEqual(THREAD_LIST.threads.map((t) => `${THREADS_URL}/${t.id}${METADATA}`));
  for (const request of google.threadRequests)
    expect(request).toMatchObject({ authorization: token, redirect: "manual" });
  expect((await callRows()).at(-1)).toMatchObject({
    account_id: f.personal.id,
    tool: "search_threads",
    outcome: "success",
  });
});

it("sends the limit and the page to Gmail, and returns no next_page when Gmail gives none", async () => {
  const f = await allowed();
  google.threadListAnswers.push(() => HttpResponse.json({ resultSizeEstimate: 0 }));
  expect(
    await rpcResult(await search(f, { query: "from:sam", limit: 25, page: "0a1b2c3d" })),
  ).toEqual(textResult({ account: PERSONAL, threads: [] }));
  expect(google.threadRequests.map((r) => r.url)).toEqual([
    `${THREADS_URL}?q=from%3Asam&maxResults=25&pageToken=0a1b2c3d`,
  ]);
});

it("refuses an input that is not valid, names the field, and asks Gmail nothing", async () => {
  const f = await allowed();
  const before = googleTraffic().length;
  for (const [args, message] of [
    [{}, "The query field must be a string that is not empty."],
    [{ query: "" }, "The query field must be a string that is not empty."],
    [{ query: 7 }, "The query field must be a string that is not empty."],
    [{ query: "a", limit: 0 }, "The limit field must be a whole number from 1 to 25."],
    [{ query: "a", limit: 26 }, "The limit field must be a whole number from 1 to 25."],
    [{ query: "a", limit: 2.5 }, "The limit field must be a whole number from 1 to 25."],
    [{ query: "a", page: "" }, "The page field must be the next_page value of an earlier result."],
    [{ query: "a", account: 5 }, "The account field must be a string."],
  ] as const)
    await expectError(await search(f, args), "invalid_arguments", message);
  await expectError(
    await toolCall(f.mcp, "search_threads"),
    "invalid_arguments",
    "The account field must be a string.",
  );
  expect(googleTraffic().slice(before)).toEqual([]);
  expect((await callRows()).at(-1)).toMatchObject({ tool: "search_threads", outcome: "refused" });
});

it("refuses a page value that Gmail refuses, and reports any other failure of the list as Google's", async () => {
  const f = await allowed();
  const refused = () =>
    HttpResponse.json({ error: { code: 400, message: "Invalid pageToken" } }, { status: 400 });
  google.threadListAnswers.push(refused);
  await expectError(
    await search(f, { query: "a", page: "stale" }),
    "invalid_arguments",
    "The page field must be the next_page value of an earlier result.",
  );
  google.threadListAnswers.push(refused);
  await expectError(
    await search(f, { query: "a" }),
    "google_unavailable",
    unavailableMessage(PERSONAL),
  );
  expect((await callRows()).slice(-2).map((row) => row.outcome)).toEqual(["refused", "failed"]);
});

it("fails the whole search when one thread cannot be read", async () => {
  const f = await allowed();
  google.threadAnswers.set(
    THREAD_LIST.threads[1]!.id,
    () => new HttpResponse(null, { status: 404 }),
  );
  await expectError(
    await search(f, { query: "a" }),
    "google_unavailable",
    unavailableMessage(PERSONAL),
  );
});

it("refreshes an expired access token once for a search with several requests", async () => {
  const f = await fixture({ access_expires_at: Date.now() - 1000 });
  await permission(f, f.personal, true, "search_threads");
  const before = google.events.filter((event) => event === "refresh").length;
  expect(await rpcResult(await search(f, { query: "a" }))).toEqual(
    textResult({ account: PERSONAL, threads: THREAD_LINES, next_page: THREAD_LIST.nextPageToken }),
  );
  expect(google.events.filter((event) => event === "refresh").length - before).toBe(1);
  const fresh = `Bearer ${google.issuedAccess.at(-1)}`;
  expect(google.threadRequests.map((r) => r.authorization)).toEqual([fresh, fresh, fresh]);
});

it("has its own setting: a connection that may list labels may not search", async () => {
  const f = await fixture();
  await permission(f);
  const before = googleTraffic().length;
  await expectError(
    await search(f, { query: "a" }),
    "account_not_available",
    refusedMessage(PERSONAL),
  );
  expect(googleTraffic().slice(before)).toEqual([]);
});

it("with ask, searches nothing until the owner approves what the page showed, then returns the threads", async () => {
  const f = await fixture();
  const set = await f.mcp.browser.post(`/connections/${f.connection.id}/permissions`, {
    account: f.personal.id,
    tool: "search_threads",
    setting: "ask",
  });
  expect(await set.json()).toEqual({ outcome: "ok" });
  const text = async (response: Response) => {
    const result = await rpcResult(response);
    return JSON.parse((result.content as Array<{ text: string }>)[0]!.text) as Record<
      string,
      unknown
    >;
  };
  const before = googleTraffic().length;
  const pending = await text(await search(f, { query: "from:kim", limit: 2 }));
  expect(pending.status).toBe("pending");
  expect(googleTraffic().slice(before)).toEqual([]);
  const page = await f.mcp.browser.get(`/approvals/${String(pending.approval)}`);
  const props = JSON.parse(
    /<script id="page-props" type="application\/json">([\s\S]*?)<\/script>/.exec(
      await page.text(),
    )![1]!,
  ) as {
    request: { tool: { action: string }; values: unknown; account: { email: string } };
    state: { kind: string; digest: string };
  };
  expect(props.request.account.email).toBe(PERSONAL);
  expect(props.request.tool.action).toBe("search the mail");
  expect(props.request.values).toEqual([
    { name: "Query", text: "from:kim" },
    { name: "Results", text: "Up to 2 threads" },
  ]);
  expect(googleTraffic().slice(before)).toEqual([]);
  const decided = await f.mcp.browser.post(`/approvals/${String(pending.approval)}/approve`, {
    digest: props.state.digest,
  });
  expect(
    ((await decided.json()) as { approval: { state: { kind: string } } }).approval.state.kind,
  ).toBe("succeeded");
  expect(google.threadRequests[0]!.url).toBe(`${THREADS_URL}?q=from%3Akim&maxResults=2`);
  expect(await text(await toolCall(f.mcp, "get_approval", { approval: pending.approval }))).toEqual(
    {
      status: "success",
      result: { account: PERSONAL, threads: THREAD_LINES, next_page: THREAD_LIST.nextPageToken },
    },
  );
});

it("is listed with its input only for a connection that may search some account", async () => {
  const f = await fixture();
  await permission(f);
  const listed = async () =>
    ((await rpcResult(await f.mcp.call())).tools as Array<Record<string, unknown>>).find(
      (tool) => tool.name === "search_threads",
    );
  expect(await listed()).toBeUndefined();
  await permission(f, f.northwind, true, "search_threads");
  expect(await listed()).toMatchObject({
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        account: { type: "string" },
        query: { type: "string", minLength: 1 },
        limit: { type: "integer", minimum: 1, maximum: 25 },
        page: { type: "string", minLength: 1 },
      },
      required: ["account", "query"],
    },
  });
});

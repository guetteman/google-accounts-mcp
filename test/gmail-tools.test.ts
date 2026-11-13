import { expect, it } from "vite-plus/test";
import { http, HttpResponse } from "msw";
import "./support/account-checks";
import { fixtureOpen, seedAccount, NOW } from "./support/accounts";
import { google, LABELS_RESPONSE, LABELS_URL } from "./support/google";
import { network } from "./support/network";
import { McpClient, rpcMessages, rpcResult } from "./support/oauth";
import {
  callRows,
  expectError,
  fixture,
  googleTraffic,
  NORTHWIND,
  permission,
  PERSONAL,
  problemCases,
  refusedMessage,
  textResult,
  toolCall,
  unavailableMessage,
} from "./support/permissions";

const labels = LABELS_RESPONSE.labels.map(({ id, name, type }) => ({ id, name, type }));

it("lists only the accounts allowed to the calling connection, ignoring agent account arguments", async () => {
  const f = await fixture();
  await permission(f);
  const other = await new McpClient().connect("Work laptop");
  const result = await rpcResult(await toolCall(f.mcp, "list_accounts", { account: NORTHWIND }));
  expect(result).toEqual(
    textResult([{ account: PERSONAL, name: "Personal", services: { gmail: { status: "ready" } } }]),
  );
  const response = await toolCall(other, "list_accounts");
  const body = await response.clone().text();
  for (const text of [PERSONAL, NORTHWIND, "Personal", "Northwind"])
    expect(body).not.toContain(text);
  expect(await rpcResult(response)).toEqual(textResult([]));
});

it("returns Gmail labels in order using only the named allowed account's token", async () => {
  const f = await fixture();
  for (const account of [f.personal, f.northwind]) {
    await permission(f, account);
    google.labelRequests.length = 0;
    const before = googleTraffic().length;
    expect(
      await rpcResult(await toolCall(f.mcp, "list_labels", { account: account.email })),
    ).toEqual(textResult({ account: account.email, labels }));
    expect(googleTraffic().slice(before)).toEqual([LABELS_URL]);
    expect(google.labelRequests).toEqual([
      {
        url: LABELS_URL,
        method: "GET",
        authorization: `Bearer ${await fixtureOpen(`${account.id}:access`, account.access_token!)}`,
        redirect: "manual",
      },
    ]);
  }
});

it("normalizes case and surrounding spaces without removing dots or plus suffixes", async () => {
  const f = await fixture();
  await permission(f);
  expect(
    await rpcResult(
      await toolCall(f.mcp, "list_labels", { account: "Alex.Personal@Example.com " }),
    ),
  ).toEqual(textResult({ account: PERSONAL, labels }));
  const before = googleTraffic().length;
  for (const account of ["alexpersonal@example.com", "alex.personal+x@example.com"])
    await expectError(
      await toolCall(f.mcp, "list_labels", { account }),
      "account_not_available",
      refusedMessage(account),
    );
  expect(googleTraffic().slice(before)).toEqual([]);
});

it("makes hidden, removed, unknown and non-address refusals byte-identical except for the exact input echo", async () => {
  const f = await fixture();
  await seedAccount({
    email: "removed@example.com",
    name: "Removed",
    state: "removed",
    removed_at: NOW,
    access_token: null,
    refresh_token: null,
    access_expires_at: null,
  });
  const before = googleTraffic().length;
  const bodies: string[] = [];
  for (const account of [
    NORTHWIND,
    "removed@example.com",
    "nobody@example.com",
    "Personal",
    " ALEX@NORTHWIND.EXAMPLE ",
  ]) {
    const response = await toolCall(f.mcp, "list_labels", { account });
    const bytes = await response.clone().text();
    await expectError(response, "account_not_available", refusedMessage(account));
    // Replace the input's JSON-within-JSON escaped bytes, without parsing or reserializing the response.
    const echoed = JSON.stringify(JSON.stringify(account).slice(1, -1)).slice(1, -1);
    bodies.push(bytes.replaceAll(echoed, "INPUT"));
  }
  expect(new Set(bodies).size).toBe(1);
  expect(googleTraffic().slice(before)).toEqual([]);
});

it.each(problemCases)(
  "hides even a $status account behind the same account-not-available refusal",
  async ({ row }) => {
    const f = await fixture(row);
    const before = googleTraffic().length;
    await expectError(
      await toolCall(f.mcp, "list_labels", { account: PERSONAL }),
      "account_not_available",
      refusedMessage(PERSONAL),
    );
    expect(googleTraffic().slice(before)).toEqual([]);
  },
);

it.each([
  { label: "missing", args: {} },
  { label: "number", args: { account: 42 } },
  { label: "list", args: { account: [PERSONAL] } },
  { label: "null", args: { account: null } },
])(
  "rejects a $label account argument with a structured field error and no Google request",
  async ({ args }) => {
    const f = await fixture();
    const before = googleTraffic().length;
    await expectError(await toolCall(f.mcp, "list_labels", args), "invalid_arguments", /account/);
    expect((await callRows())[0]).toMatchObject({
      outcome: "refused",
      reason: "invalid_arguments",
    });
    expect(googleTraffic().slice(before)).toEqual([]);
  },
);

it("keeps the SDK invalid-params error for an unknown tool without contacting Google", async () => {
  const f = await fixture();
  const before = googleTraffic().length;
  const { messages } = await rpcMessages(await toolCall(f.mcp, "send_everything"));
  expect(messages).toHaveLength(1);
  expect(messages[0]!.error?.code).toBe(-32602);
  expect(messages[0]!.result).toBeUndefined();
  expect(googleTraffic().slice(before)).toEqual([]);
});

it.each(problemCases)(
  "lists an allowed $status account with the exact owner recovery message",
  async ({ row, status, message }) => {
    const f = await fixture(row);
    await permission(f);
    const before = googleTraffic().length;
    expect(await rpcResult(await toolCall(f.mcp, "list_accounts"))).toEqual(
      textResult([
        { account: PERSONAL, name: "Personal", services: { gmail: { status, message } } },
      ]),
    );
    expect(googleTraffic().slice(before)).toEqual([]);
  },
);

it.each(problemCases)(
  "refuses an allowed $status account before contacting Google",
  async ({ row, status, message }) => {
    const f = await fixture(row);
    await permission(f);
    const before = googleTraffic().length;
    await expectError(
      await toolCall(f.mcp, "list_labels", { account: PERSONAL }),
      `account_${status}`,
      message,
    );
    expect(googleTraffic().slice(before)).toEqual([]);
    expect((await callRows())[0]).toMatchObject({
      account_id: f.personal.id,
      outcome: "failed",
      reason: `account_${status}`,
    });
  },
);

it("reports revoked Google access discovered during refresh without sending a Gmail request", async () => {
  const f = await fixture({ access_expires_at: NOW });
  await permission(f);
  google.refreshAnswers.push("invalid_grant");
  const before = googleTraffic().length;
  await expectError(
    await toolCall(f.mcp, "list_labels", { account: PERSONAL }),
    "account_needs_reconnect",
    problemCases[0]!.message,
  );
  expect(googleTraffic().slice(before)).toEqual(["https://oauth2.googleapis.com/token"]);
  expect((await callRows())[0]).toMatchObject({ account_id: f.personal.id, outcome: "failed" });
});

it("refuses and records an account removed by the owner during token refresh", async () => {
  const f = await fixture({ access_expires_at: NOW });
  await permission(f);
  google.refreshAnswers.push(async () => {
    expect(await (await f.mcp.browser.post(`/accounts/${f.personal.id}/remove`)).json()).toEqual({
      outcome: "ok",
    });
    return HttpResponse.json({
      access_token: "refreshed-test-access",
      expires_in: 3600,
      token_type: "Bearer",
    });
  });
  await expectError(
    await toolCall(f.mcp, "list_labels", { account: PERSONAL }),
    "account_not_available",
    refusedMessage(PERSONAL),
  );
  expect(google.labelRequests).toEqual([]);
  expect((await callRows())[0]).toMatchObject({ account_id: f.personal.id, outcome: "refused" });
});

it("reports a token endpoint failure as Google unavailable", async () => {
  const f = await fixture({ access_expires_at: NOW });
  await permission(f);
  google.refreshAnswers.push(503);
  await expectError(
    await toolCall(f.mcp, "list_labels", { account: PERSONAL }),
    "google_unavailable",
    unavailableMessage(PERSONAL),
  );
  expect(google.labelRequests).toEqual([]);
  expect((await callRows())[0]).toMatchObject({ outcome: "failed", reason: "google_unavailable" });
});

it.each([400, 401, 403, 429, 500, 503])(
  "reports Gmail HTTP %s as Google unavailable",
  async (status) => {
    const f = await fixture();
    await permission(f);
    const answer = () => HttpResponse.json({ error: "PRIVATE_GOOGLE_BODY" }, { status });
    google.labelAnswers.push(answer);
    // withGoogle refreshes once after a 401; its final Gmail response must fail too.
    if (status === 401) google.labelAnswers.push(answer);
    await expectError(
      await toolCall(f.mcp, "list_labels", { account: PERSONAL }),
      "google_unavailable",
      unavailableMessage(PERSONAL),
    );
    expect((await callRows())[0]).toMatchObject({ outcome: "failed" });
  },
);

it("does not follow Gmail redirects or forward a token to the redirect host", async () => {
  const f = await fixture();
  await permission(f);
  const redirected: string[] = [];
  network.use(
    http.get("https://redirect.example/labels", ({ request }) => {
      redirected.push(request.headers.get("Authorization") ?? "");
      return HttpResponse.json(LABELS_RESPONSE);
    }),
  );
  google.labelAnswers.push(
    () =>
      new HttpResponse(null, {
        status: 302,
        headers: { Location: "https://redirect.example/labels" },
      }),
  );
  await expectError(
    await toolCall(f.mcp, "list_labels", { account: PERSONAL }),
    "google_unavailable",
    unavailableMessage(PERSONAL),
  );
  expect(google.labelRequests).toHaveLength(1);
  expect(google.labelRequests[0]!.redirect).toBe("manual");
  expect(redirected).toEqual([]);
});

it.each([
  { label: "null", body: null },
  { label: "array", body: [] },
  { label: "null labels", body: { labels: null } },
  { label: "object labels", body: { labels: {} } },
  { label: "missing label fields", body: { labels: [{}] } },
  { label: "numeric ID", body: { labels: [{ id: 4, name: "INBOX", type: "system" }] } },
  {
    label: "invalid label type",
    body: { labels: [{ id: "INBOX", name: "INBOX", type: "invalid" }] },
  },
])("rejects an undocumented Gmail labels body with $label", async ({ body }) => {
  const f = await fixture();
  await permission(f);
  google.labelAnswers.push(() => HttpResponse.json(body));
  await expectError(
    await toolCall(f.mcp, "list_labels", { account: PERSONAL }),
    "google_unavailable",
    unavailableMessage(PERSONAL),
  );
});

it("rejects invalid JSON from Gmail with the same structured error", async () => {
  const f = await fixture();
  await permission(f);
  google.labelAnswers.push(() => new HttpResponse("not json"));
  await expectError(
    await toolCall(f.mcp, "list_labels", { account: PERSONAL }),
    "google_unavailable",
    unavailableMessage(PERSONAL),
  );
});

it("leaves an unknown outcome when the Gmail connection drops", async () => {
  const f = await fixture();
  await permission(f);
  google.labelAnswers.push(() => HttpResponse.error());
  await expectError(
    await toolCall(f.mcp, "list_labels", { account: PERSONAL }),
    "google_unavailable",
    unavailableMessage(PERSONAL),
  );
  expect(await callRows()).toEqual([
    expect.objectContaining({ account_id: f.personal.id, outcome: null }),
  ]);
});

it("returns the same labels and record through the modern MCP envelope", async () => {
  const f = await fixture();
  await permission(f);
  const response = await f.mcp.raw(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "list_labels",
        arguments: { account: PERSONAL },
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    },
    undefined,
    { "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/call", "Mcp-Name": "list_labels" },
  );
  const result = await rpcResult(response);
  expect(result.content).toEqual(textResult({ account: PERSONAL, labels }).content);
  expect(result.isError).toBeUndefined();
  expect(await callRows()).toEqual([
    expect.objectContaining({
      connection_id: f.connection.id,
      account_id: f.personal.id,
      tool: "list_labels",
      at: NOW,
      outcome: "success",
    }),
  ]);
});

it("accepts the modern tool-call envelope for a connection with no allowed accounts", async () => {
  const f = await fixture();
  const response = await f.mcp.raw(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "list_accounts",
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    },
    undefined,
    {
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": "tools/call",
      "Mcp-Name": "list_accounts",
    },
  );
  const result = await rpcResult(response);
  expect(result.content).toEqual(textResult([]).content);
  expect(result.isError).toBeUndefined();
});

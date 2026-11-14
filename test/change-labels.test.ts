import { env } from "cloudflare:workers";
import { HttpResponse } from "msw";
import { expect, it, vi } from "vite-plus/test";
import "./support/account-checks";
import { answer } from "./support/approvals";
import { MAX_ITEMS } from "../src/google/gmail";
import { google, LABELS_URL, THREADS_URL, deferred } from "./support/google";
import { rpcResult } from "./support/oauth";
import {
  callRows,
  expectError,
  fixture,
  googleTraffic,
  PERSONAL,
  textResult,
  unavailableMessage,
  unconfirmedMessage,
} from "./support/permissions";
import {
  allowed,
  CHANGE,
  FIFTH,
  fieldMessage,
  FIRST,
  FOURTH,
  labelCall,
  labels,
  MISSING,
  mixed,
  SECOND,
  setting,
  SYSTEM_IDS,
} from "./support/labels";

it.each(
  [
    [],
    Array.from({ length: MAX_ITEMS + 1 }, (_, i) => `id_${i}`),
    [FIRST, FIRST],
    ["a/b"],
    "thread",
    [""],
    ["x".repeat(65)],
    [1],
  ].map((threads) => ({ threads })),
)("refuses invalid threads $threads before an approval or Google", async ({ threads }) => {
  const f = await fixture();
  await setting(f, "ask");
  await expectError(
    await labelCall(f, { ...CHANGE, threads }),
    "invalid_arguments",
    "The threads field must be a list of 1 to 100 different thread IDs that search_threads returned.",
  );
  expect(googleTraffic()).toEqual([]);
  expect(await env.DB.prepare("SELECT count(*) AS n FROM approvals").first()).toEqual({ n: 0 });
});

it("accepts the most distinct IDs one call allows, including the syntax boundaries", async () => {
  const f = await allowed();
  const ids = [
    "a",
    "b".repeat(64),
    ...Array.from({ length: MAX_ITEMS - 2 }, (_, i) => `id_${i}-ok`),
  ];
  for (const id of ids)
    google.modifyAnswers.set(id, () =>
      HttpResponse.json({ id, messages: [{ id: `m_${id}`, threadId: id }] }),
    );
  const result = await answer(await labelCall(f, { ...CHANGE, threads: ids }));
  expect(result).toEqual({
    account: PERSONAL,
    threads: ids.map((thread) => ({ thread, labels: [] })),
  });
  expect(google.modifyRequests).toHaveLength(MAX_ITEMS);
});

it.each(["add", "remove"] as const)(
  "refuses invalid %s lists with the whole message",
  async (field) => {
    const f = await fixture();
    await setting(f, "ask");
    for (const value of [
      Array(101).fill("Label_12"),
      [""],
      "Label_12",
      ["x".repeat(101)],
      ["bad id"],
      ["bad\nid"],
    ]) {
      await expectError(
        await labelCall(f, { ...CHANGE, [field]: value }),
        "invalid_arguments",
        fieldMessage(field),
      );
      expect(googleTraffic()).toEqual([]);
      expect(await env.DB.prepare("SELECT count(*) AS n FROM approvals").first()).toEqual({ n: 0 });
    }
  },
);

it("accepts repeated label IDs and the one-hundred-label boundary", async () => {
  const f = await allowed();
  labels();
  expect(
    await answer(await labelCall(f, { threads: [FIRST], add: ["STARRED", "STARRED"] })),
  ).toMatchObject({
    account: PERSONAL,
    threads: [{ thread: FIRST, labels: ["INBOX", "STARRED", "UNREAD"] }],
  });
  expect(google.modifyRequests[0]!.body).toEqual({ addLabelIds: ["STARRED", "STARRED"] });
  await answer(await labelCall(f, { ...CHANGE, add: Array(100).fill("Label_12") }));
  expect(google.modifyRequests[1]!.body).toEqual({
    addLabelIds: Array(100).fill("Label_12"),
    removeLabelIds: ["INBOX"],
  });
  const id = "x".repeat(100);
  labels([{ id, name: "Long label", type: "user" }]);
  await answer(await labelCall(f, { threads: [FIRST], add: [id] }));
  expect(google.modifyRequests[2]!.body).toEqual({ addLabelIds: [id] });
});

it.each([
  ...["TRASH", "SPAM", "SENT", "DRAFT"].flatMap((id) =>
    ["add", "remove"].map((field) => ({ id, field })),
  ),
  { id: "INBOX", field: "add" },
])("refuses $id in $field before an approval", async ({ id, field }) => {
  const f = await fixture();
  await setting(f, "ask");
  await expectError(
    await labelCall(f, { threads: [FIRST], [field]: [id] }),
    "invalid_arguments",
    fieldMessage(field),
  );
  expect(googleTraffic()).toEqual([]);
  expect(await env.DB.prepare("SELECT count(*) AS n FROM approvals").first()).toEqual({ n: 0 });
});

it.each([
  { args: {}, field: "add" },
  { args: { add: [], remove: [] }, field: "add" },
  { args: { add: [] }, field: "add" },
  { args: { remove: [] }, field: "add" },
  { args: { add: ["STARRED"], remove: ["STARRED"] }, field: "remove" },
])("refuses empty or overlapping changes $args at $field", async ({ args, field }) => {
  const f = await fixture();
  await setting(f, "ask");
  await expectError(
    await labelCall(f, { threads: [FIRST], ...args }),
    "invalid_arguments",
    fieldMessage(field),
  );
  expect(googleTraffic()).toEqual([]);
  expect(await env.DB.prepare("SELECT count(*) AS n FROM approvals").first()).toEqual({ n: 0 });
});

it("reads labels first and refreshes an expired token once for several writes", async () => {
  const f = await allowed({ access_expires_at: Date.now() - 1 });
  await answer(await labelCall(f, { ...CHANGE, threads: [FIRST, SECOND] }));
  expect(google.refreshTokens).toHaveLength(1);
  expect(google.labelRequests).toHaveLength(1);
  expect(google.methods).toEqual(["GET", "POST", "POST"]);
  expect(googleTraffic().filter((url) => url.includes("gmail.googleapis.com"))).toEqual([
    LABELS_URL,
    `${THREADS_URL}/${FIRST}/modify`,
    `${THREADS_URL}/${SECOND}/modify`,
  ]);
});
it("preserves a failed label read and changes nothing", async () => {
  const f = await allowed();
  google.labelAnswers.push(() => new HttpResponse(null, { status: 500 }));
  await expectError(await labelCall(f), "google_unavailable", unavailableMessage(PERSONAL));
  expect(google.modifyRequests).toEqual([]);
});
it("reports a lost label read as a failure that changed nothing", async () => {
  const f = await allowed();
  google.labelAnswers.push(() => HttpResponse.error());
  await expectError(await labelCall(f), "google_unavailable", unavailableMessage(PERSONAL));
  expect(google.modifyRequests).toEqual([]);
  expect((await callRows()).at(-1)?.outcome).toBe("failed");
});

it.each([
  { add: ["missing_add"], remove: ["INBOX"], id: "missing_add" },
  { add: ["Label_12"], remove: ["missing_remove", "another"], id: "missing_remove" },
  { add: ["missing_add", "another"], remove: ["missing_remove"], id: "missing_add" },
])("names the first missing label in add then remove: $id", async ({ add, remove, id }) => {
  const f = await allowed();
  await expectError(
    await labelCall(f, { threads: [FIRST], add, remove }),
    "not_found",
    `No label "${id}" exists in ${PERSONAL}. A label ID works only in the account that returned it.`,
  );
  expect(google.modifyRequests).toEqual([]);
});

it.each([
  { field: "add", ids: ["CHAT"] },
  { field: "add", ids: ["CHAT", "Label_missing"] },
  { field: "remove", ids: ["YELLOW_STAR"] },
])("refuses listed system labels in $field before missing labels: $ids", async ({ field, ids }) => {
  const f = await allowed();
  labels([
    { id: "CHAT", name: "Chats", type: "system" },
    { id: "YELLOW_STAR", name: "Yellow star", type: "system" },
  ]);
  await expectError(
    await labelCall(f, { threads: [FIRST], [field]: ids }),
    "invalid_arguments",
    fieldMessage(field),
  );
  expect(google.modifyRequests).toEqual([]);
});
it.each([
  { field: "add", ids: [...SYSTEM_IDS.filter((id) => id !== "INBOX"), "Label_12"] },
  { field: "remove", ids: [...SYSTEM_IDS, "Label_12"] },
])("accepts supported system labels and user labels in $field", async ({ field, ids }) => {
  const f = await allowed();
  labels();
  await answer(await labelCall(f, { threads: [FIRST], [field]: ids }));
  expect(google.modifyRequests[0]!.body).toEqual({ [`${field}LabelIds`]: ids });
});

it.each([{ add: ["Label_12"] }, { remove: ["INBOX"] }, { add: ["Label_12"], remove: ["INBOX"] }])(
  "sends only the declared JSON fields via authorized manual POST: %j",
  async (change) => {
    const f = await allowed();
    await answer(await labelCall(f, { threads: [FIRST], ...change }));
    expect(google.modifyRequests).toEqual([
      {
        url: `${THREADS_URL}/${FIRST}/modify`,
        method: "POST",
        thread: FIRST,
        body: {
          ...("add" in change ? { addLabelIds: change.add } : {}),
          ...("remove" in change ? { removeLabelIds: change.remove } : {}),
        },
        authorization: expect.stringMatching(/^Bearer PRIVATE_GOOGLE_TOKEN_/),
        redirect: "manual",
      },
    ]);
    expect(google.methods).toEqual(["GET", "POST"]);
  },
);

it.each([
  {
    status: 201,
    messages: [
      { id: "m1", threadId: FIRST, labelIds: ["B", "A", "B"] },
      { id: "m2", threadId: FIRST, labelIds: ["A", "C"] },
    ],
    expected: ["B", "A", "C"],
  },
  {
    status: 200,
    messages: [
      { id: "m1", threadId: FIRST },
      { id: "m2", threadId: FIRST },
    ],
    expected: [],
  },
])(
  "derives the label union from the observed messages response at $status",
  async ({ status, messages, expected }) => {
    const f = await allowed();
    google.modifyAnswers.set(FIRST, () => HttpResponse.json({ id: FIRST, messages }, { status }));
    expect(await answer(await labelCall(f))).toEqual({
      account: PERSONAL,
      threads: [{ thread: FIRST, labels: expected }],
    });
  },
);

it.each([400, 404])(
  "continues after status %s on either the first or a later thread",
  async (status) => {
    const f = await allowed();
    for (const missing of [FIRST, SECOND]) {
      google.modifyAnswers.clear();
      google.modifyAnswers.set(missing, () => new HttpResponse(null, { status }));
      expect(await answer(await labelCall(f, { ...CHANGE, threads: [FIRST, SECOND] }))).toEqual({
        account: PERSONAL,
        threads: [
          missing === FIRST
            ? { thread: SECOND, labels: ["Label_12"] }
            : { thread: FIRST, labels: ["Label_12", "UNREAD"] },
        ],
        not_found: [missing],
      });
    }
  },
);
it.each([403, 429])("keeps a later %s refusal unconfirmed", async (status) => {
  const f = await allowed();
  google.modifyAnswers.set(SECOND, () => new HttpResponse(null, { status }));
  expect(await answer(await labelCall(f, { ...CHANGE, threads: [FIRST, SECOND] }))).toEqual({
    account: PERSONAL,
    threads: [{ thread: FIRST, labels: ["Label_12", "UNREAD"] }],
    unconfirmed: [SECOND],
  });
});

it.each(["503", "redirect", "lost", "invalid JSON", "missing messages", "empty messages"])(
  "keeps a later %s answer unconfirmed",
  async (failure) => {
    const f = await allowed();
    google.modifyAnswers.set(SECOND, () =>
      failure === "503"
        ? new HttpResponse(null, { status: 503 })
        : failure === "redirect"
          ? new HttpResponse(null, { status: 302, headers: { Location: "https://wrong.example/" } })
          : failure === "lost"
            ? HttpResponse.error()
            : failure === "invalid JSON"
              ? new HttpResponse("not JSON")
              : HttpResponse.json(failure === "empty messages" ? { messages: [] } : {}),
    );
    expect(await answer(await labelCall(f, { ...CHANGE, threads: [FIRST, SECOND] }))).toEqual({
      account: PERSONAL,
      threads: [{ thread: FIRST, labels: ["Label_12", "UNREAD"] }],
      unconfirmed: [SECOND],
    });
  },
);

it("orders partial lists, uses the stored account, omits empty lists and records success", async () => {
  const f = await allowed();
  const threads = mixed();
  const result = await rpcResult(
    await labelCall(f, { ...CHANGE, account: " Alex.Personal@Example.com ", threads }),
  );
  expect((await callRows()).at(-1)).toMatchObject({ tool: "change_labels", outcome: "success" });
  expect(result).toEqual(
    textResult({
      account: PERSONAL,
      threads: [
        { thread: FIRST, labels: ["Label_12", "UNREAD"] },
        { thread: SECOND, labels: ["Label_12"] },
        { thread: FIFTH, labels: ["STARRED"] },
      ],
      not_found: [MISSING],
      unconfirmed: [FOURTH],
    }),
  );
  expect(await answer(await labelCall(f))).toEqual({
    account: PERSONAL,
    threads: [{ thread: FIRST, labels: ["Label_12", "UNREAD"] }],
  });
});

it.each([{ ids: [MISSING] }, { ids: [MISSING, FOURTH, FIFTH] }])(
  "names all missing threads $ids and records refused",
  async ({ ids }) => {
    const f = await allowed();
    await expectError(
      await labelCall(f, { ...CHANGE, threads: ids }),
      "not_found",
      `${ids.length === 1 ? `No thread "${MISSING}"` : `None of the threads "${MISSING}", "${FOURTH}", "${FIFTH}"`} exists in ${PERSONAL}. A thread ID works only in the account that returned it.`,
    );
    expect((await callRows()).at(-1)?.outcome).toBe("refused");
  },
);

it.each([
  { name: "first 429", statuses: [429, 429, 429], count: 1, outcome: "failed" },
  { name: "first lost response", statuses: ["lost", 429, 429], count: 1, outcome: null },
  { name: "first 500", statuses: [500, 429], count: 1, outcome: null },
  { name: "missing then 429", statuses: [404, 429], count: 2, outcome: "failed" },
  {
    name: "missing then 429 then lost response",
    statuses: [404, 429, "lost"],
    count: 3,
    outcome: null,
  },
])("preserves the failure and audit for $name", async ({ statuses, count, outcome }) => {
  const f = await allowed();
  const ids = [FIRST, SECOND, FIFTH].slice(0, statuses.length);
  statuses.forEach((status, index) =>
    google.modifyAnswers.set(ids[index]!, () =>
      status === "lost" ? HttpResponse.error() : new HttpResponse(null, { status: Number(status) }),
    ),
  );
  const result = await rpcResult(await labelCall(f, { ...CHANGE, threads: ids }));
  expect(google.modifyRequests).toHaveLength(count);
  expect((await callRows()).at(-1)?.outcome).toBe(outcome);
  expect(result).toEqual({
    ...textResult({
      code: "google_unavailable",
      message: outcome === null ? unconfirmedMessage(PERSONAL) : unavailableMessage(PERSONAL),
    }),
    isError: true,
  });
});

it("answers at twenty seconds and retains earlier confirmed changes", async () => {
  const f = await allowed();
  const release = deferred();
  google.labelAnswers.push(
    () =>
      new Promise((resolve) =>
        setTimeout(
          () =>
            resolve(
              HttpResponse.json({
                labels: [
                  { id: "INBOX", name: "INBOX", type: "system" },
                  { id: "Label_12", name: "Receipts", type: "user" },
                ],
              }),
            ),
          9000,
        ),
      ),
  );
  google.modifyAnswers.set(
    FIRST,
    () =>
      new Promise((resolve) =>
        setTimeout(
          () => resolve(HttpResponse.json({ messages: [{ labelIds: ["Label_12"] }] })),
          9000,
        ),
      ),
  );
  google.modifyAnswers.set(
    SECOND,
    (request) =>
      new Promise<Response>((resolve, reject) => {
        request.signal.addEventListener("abort", () => reject(request.signal.reason), {
          once: true,
        });
        void release.promise.then(() => resolve(new HttpResponse(null, { status: 503 })));
      }),
  );
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  let settled: number | null = null;
  const at = Date.now();
  const pending = labelCall(f, { ...CHANGE, threads: [FIRST, SECOND] })
    .then(rpcResult)
    .then((result) => {
      settled = Date.now() - at;
      return result;
    });
  try {
    for (let i = 0; i < 300 && settled === null; i++) await vi.advanceTimersByTimeAsync(100);
    expect(settled).toBe(20_000);
    expect(await pending).toEqual(
      textResult({
        account: PERSONAL,
        threads: [{ thread: FIRST, labels: ["Label_12"] }],
        unconfirmed: [SECOND],
      }),
    );
    expect((await callRows()).at(-1)?.outcome).toBe("success");
  } finally {
    release.resolve();
    vi.useRealTimers();
    await pending;
  }
});

it("lists annotations and arrays", async () => {
  const f = await fixture();
  await setting(f, "ask");
  const result = await rpcResult(await f.mcp.call());
  const tool = (result.tools as Array<Record<string, unknown>>).find(
    (tool) => tool.name === "change_labels",
  )!;
  expect(tool.annotations).toEqual({
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  });
  expect(tool.inputSchema).toMatchObject({
    type: "object",
    required: ["account", "threads"],
    properties: {
      threads: { type: "array", items: { type: "string" } },
      add: { type: "array", items: { type: "string" } },
      remove: { type: "array", items: { type: "string" } },
    },
  });
  expect(googleTraffic()).toEqual([]);
});

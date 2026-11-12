import { env } from "cloudflare:workers";
import { expect, it, vi } from "vite-plus/test";
import "./support/account-checks";
import type { TestEnv } from "./env";
import { previews } from "../src/pages/previews";
import { renderPage } from "../src/pages/render";
import { NOW } from "./support/accounts";
import { decided, get, page, post, row } from "./support/approvals";
import { observeStatements } from "./support/db";
import { deferred, google, MESSAGES_URL } from "./support/google";
import { requests } from "./support/network";
import { callRows, PERSONAL } from "./support/permissions";
import { message } from "./support/thread";
import { asking, changed, ids15, operations, serveMessages, WARNING } from "./support/trash";
import { ORIGIN, testEnv, textOf } from "./support/worker";

const metadataUrl = (id: string) =>
  `${MESSAGES_URL}/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From`;

it.each(operations)(
  "$name shows ordered Gmail values for two messages and only sends GETs",
  async (op) => {
    serveMessages(["m1", "m2"]);
    google.trashAnswers.set("m2", () =>
      Response.json({
        ...message("m2"),
        internalDate: "1794392100000",
        payload: {
          headers: [
            { name: "From", value: "Kim <kim@example.com>" },
            { name: "Subject", value: "Re: Lunch" },
          ],
        },
      }),
    );
    const before = requests.length;
    const f = await asking(op.name);
    expect(requests.slice(before).filter((url) => url.startsWith(MESSAGES_URL))).toEqual([]);
    const start = requests.length;
    const props = await page(f, f.id);
    expect(props.state).toMatchObject({ kind: "waiting", shown: true });
    expect(props.request.values).toEqual([
      { name: "Message 1 from", text: "Sam <sam@example.com>", from: "gmail" },
      { name: "Message 1 subject", text: "Lunch", from: "gmail" },
      { name: "Message 1 date", text: "Nov 11, 2026 at 09:41 UTC", from: "gmail" },
      { name: "Message 2 from", text: "Kim <kim@example.com>", from: "gmail" },
      { name: "Message 2 subject", text: "Re: Lunch", from: "gmail" },
      { name: "Message 2 date", text: "Nov 11, 2026 at 10:15 UTC", from: "gmail" },
    ]);
    const text = textOf(await renderPage(props).text());
    expect(text).toContain(
      "The server read the shaded text below from Gmail. The agent did not write it.",
    );
    expect(requests.slice(start)).toEqual([metadataUrl("m1"), metadataUrl("m2")]);
    expect(google.methods).toEqual(["GET", "GET"]);
    expect((await callRows()).map((r) => r.outcome)).toEqual(["pending"]);
  },
);

it.each(operations)(
  "$name uses singular names and bounds each header to 500 characters",
  async (op) => {
    google.trashAnswers.set("m1", () =>
      Response.json({
        ...message(),
        payload: {
          headers: [
            { name: "from", value: "f".repeat(3000) },
            { name: "SUBJECT", value: "s".repeat(3000) },
          ],
        },
      }),
    );
    const f = await asking(op.name, ["m1"]);
    const start = requests.length;
    const props = await page(f, f.id);
    expect(props.request.values).toEqual([
      { name: "From", text: "f".repeat(499) + "…", from: "gmail" },
      { name: "Subject", text: "s".repeat(499) + "…", from: "gmail" },
      { name: "Date", text: "Nov 11, 2026 at 09:41 UTC", from: "gmail" },
    ]);
    expect(requests.slice(start)).toEqual([metadataUrl("m1")]);
    expect(google.methods).toEqual(["GET"]);
  },
);

it("the view reads its first message alone, refreshes once and opens at most five", async () => {
  const f = await asking("delete_messages", ids15);
  await env.DB.prepare("UPDATE accounts SET access_expires_at = ? WHERE id = ?")
    .bind(NOW, f.personal.id)
    .run();
  const entered = ids15.map(() => deferred());
  const gates = ids15.map(() => deferred());
  let open = 0;
  let most = 0;
  ids15.forEach((id, i) =>
    google.trashAnswers.set(id, async () => {
      most = Math.max(most, ++open);
      entered[i]!.resolve();
      await gates[i]!.promise;
      open--;
      return Response.json(message(id));
    }),
  );
  const pending = page(f, f.id);
  try {
    await entered[0]!.promise;
    expect(google.trashRequests).toHaveLength(1);
    expect(open).toBe(1);
    gates[0]!.resolve();
    await Promise.all(entered.slice(1, 6).map((e) => e.promise));
    expect(open).toBe(5);
    for (const gate of gates) gate.resolve();
    expect((await pending).state).toMatchObject({ kind: "waiting", shown: true });
    expect(google.refreshTokens).toHaveLength(1);
    expect(most).toBe(5);
    expect(open).toBe(0);
    expect(google.methods).toEqual(ids15.map(() => "GET"));
  } finally {
    for (const gate of gates) gate.resolve();
    await pending;
  }
});

it.each([400, 404])(
  "a %s read shows the missing ID from the agent and keeps Approve",
  async (status) => {
    serveMessages(["m1", "m2"]);
    google.trashAnswers.set("m2", () => new Response(null, { status }));
    const f = await asking("delete_messages");
    const props = await page(f, f.id);
    expect(props.state).toMatchObject({ kind: "waiting", shown: true });
    expect(props.request.values).toHaveLength(4);
    expect(props.request.values.at(-1)).toEqual({
      name: "Message 2 ID, not found in this account",
      text: "m2",
      from: "agent",
    });
    const html = await renderPage(props).text();
    expect(html).toContain(">Approve</button>");
    const text = textOf(html);
    expect(text).toContain("Message 2 ID, not found in this account, written by the agent");
    expect(text).toContain("Message 1 subject, read from Gmail");
  },
);

it.each([400, 404])(
  "one missing message with a %s read uses the singular ID label",
  async (status) => {
    google.trashAnswers.set("m2", () => new Response(null, { status }));
    const f = await asking("trash_messages", ["m2"]);
    expect((await page(f, f.id)).request.values).toEqual([
      { name: "Message ID, not found in this account", text: "m2", from: "agent" },
    ]);
  },
);

it.each([403, 429, 500])("a %s read fails the view and hides Approve", async (status) => {
  serveMessages(["m1", "m2"]);
  google.trashAnswers.set("m2", () => new Response(null, { status }));
  const f = await asking("delete_messages");
  const props = await page(f, f.id);
  expect(props.state).toMatchObject({ kind: "waiting", shown: false, digest: null });
  expect(props.request.values).toEqual([]);
  expect(props.request.notes).toEqual([]);
  const html = await renderPage(props).text();
  expect(html).not.toContain(">Approve</button>");
  expect(html).toContain(">Reject</button>");
});

it.each(["", "NaN", "1.2", "8640000000000001"])(
  "a malformed internalDate %s hides Approve",
  async (internalDate) => {
    google.trashAnswers.set("m1", () => Response.json({ ...message(), internalDate }));
    const f = await asking("trash_messages", ["m1"]);
    expect((await page(f, f.id)).state).toMatchObject({ kind: "waiting", shown: false });
  },
);

it.each(operations)(
  "$name shows the exact headline and warns only for permanent deletion",
  async (op) => {
    serveMessages(["m1", "m2"]);
    const f = await asking(op.name);
    const props = await page(f, f.id);
    expect(props.request.tool).toMatchObject({
      label: op.label,
      action: op.action,
      joiner: op.joiner,
    });
    expect(props.request.notes).toEqual(
      op.name === "delete_messages" ? [{ text: WARNING, warning: true }] : [],
    );
    const html = (await renderPage(props).text()).replace(/<script[\s\S]*?<\/script>/g, "");
    const text = textOf(html).replace(/\s+\./g, ".");
    expect(text).toContain(`${f.connection.name} wants to ${op.action} ${op.joiner} Personal.`);
    if (op.name === "delete_messages") {
      expect(text).toContain(WARNING);
      expect(html.indexOf(WARNING)).toBeGreaterThan(html.lastIndexOf("</blockquote>"));
      expect(html.indexOf(WARNING)).toBeLessThan(html.indexOf(">Approve</button>"));
      expect(html).toMatch(/role="alert"[\s\S]*?These messages cannot be recovered/);
    } else expect(text).not.toContain(WARNING);
  },
);

it.each(operations)(
  "Approve runs both $name changes and get_approval returns the result",
  async (op) => {
    serveMessages(["m1", "m2"]);
    const f = await asking(op.name);
    const shown = await page(f, f.id);
    if (shown.state.kind !== "waiting") throw new Error("Expected waiting");
    expect(
      (await decided(await post(f, f.id, "approve", { digest: shown.state.digest! }))).state.kind,
    ).toBe("succeeded");
    expect(await get(f, f.id)).toEqual({
      status: "success",
      result: { account: PERSONAL, messages: changed(op.name, ["m1", "m2"]) },
    });
    expect(google.trashRequests.map(({ method, url }) => ({ method, url }))).toEqual([
      ...["m1", "m2", "m1", "m2"].map((id) => ({ method: "GET", url: metadataUrl(id) })),
      ...["m1", "m2"].map((id) => ({
        method: op.method,
        url: `${MESSAGES_URL}/${id}${op.suffix}`,
      })),
    ]);
    expect((await callRows()).map((r) => r.outcome)).toEqual(["success", "success"]);
  },
);

it.each(operations)(
  "a message missing after viewing $name changes the digest and runs nothing",
  async (op) => {
    serveMessages(["m1", "m2"]);
    const f = await asking(op.name);
    const shown = await page(f, f.id);
    if (shown.state.kind !== "waiting") throw new Error("Expected waiting");
    google.trashAnswers.set("m2", () => new Response(null, { status: 404 }));
    const props = await decided(await post(f, f.id, "approve", { digest: shown.state.digest! }));
    expect(props.state).toMatchObject({ kind: "waiting", shown: true, changed: true });
    expect(textOf(await renderPage(props).text())).toContain("Nothing ran. The request changed.");
    expect(google.trashRequests.every((r) => r.method === "GET")).toBe(true);
    expect((await callRows()).map((r) => r.outcome)).toEqual(["pending"]);
  },
);

it.each(operations)(
  "Approve on all-missing messages runs $name and returns failed not_found",
  async (op) => {
    for (const id of ["m1", "m2"])
      google.trashAnswers.set(id, () => new Response(null, { status: 404 }));
    const f = await asking(op.name);
    const shown = await page(f, f.id);
    if (shown.state.kind !== "waiting") throw new Error("Expected waiting");
    expect(
      (await decided(await post(f, f.id, "approve", { digest: shown.state.digest! }))).state.kind,
    ).toBe("failed");
    expect(await get(f, f.id)).toEqual({
      status: "failed",
      error: {
        code: "not_found",
        message: `None of the messages "m1", "m2" exists in ${PERSONAL}. A message ID works only in the account that returned it.`,
      },
    });
    expect(google.trashRequests.filter((r) => r.method !== "GET").map((r) => r.url)).toEqual(
      ["m1", "m2"].map((id) => `${MESSAGES_URL}/${id}${op.suffix}`),
    );
    expect((await callRows()).map((r) => r.outcome)).toEqual(["refused", "success"]);
  },
);

it.each(operations)(
  "a message missing between the rebuilt view and $name run is not_found",
  async (op) => {
    serveMessages(["m1", "m2"]);
    const f = await asking(op.name);
    const shown = await page(f, f.id);
    if (shown.state.kind !== "waiting") throw new Error("Expected waiting");
    google.trashAnswers.set("m2", (request) =>
      request.method === "GET" ? Response.json(message("m2")) : new Response(null, { status: 404 }),
    );
    expect(
      (await decided(await post(f, f.id, "approve", { digest: shown.state.digest! }))).state.kind,
    ).toBe("succeeded");
    expect(await get(f, f.id)).toEqual({
      status: "success",
      result: {
        account: PERSONAL,
        messages: changed(op.name, ["m1"]),
        not_found: ["m2"],
      },
    });
  },
);

it.each(operations)(
  "$name attempts every named ID when the page already shows one as missing",
  async (op) => {
    const ids = ["m1", "m2", "m3"];
    serveMessages(ids);
    google.trashAnswers.set("m2", () => new Response(null, { status: 404 }));
    const f = await asking(op.name, ids);
    const shown = await page(f, f.id);
    expect(shown.state).toMatchObject({ kind: "waiting", shown: true });
    expect(shown.request.values[3]).toEqual({
      name: "Message 2 ID, not found in this account",
      text: "m2",
      from: "agent",
    });
    expect(await renderPage(shown).text()).toContain(">Approve</button>");
    if (shown.state.kind !== "waiting") throw new Error("Expected waiting");
    const start = requests.length;
    expect(
      (await decided(await post(f, f.id, "approve", { digest: shown.state.digest! }))).state.kind,
    ).toBe("succeeded");
    expect(await get(f, f.id)).toEqual({
      status: "success",
      result: {
        account: PERSONAL,
        messages: changed(op.name, ["m1", "m3"]),
        not_found: ["m2"],
      },
    });
    const changes = ids.map((id) => `${MESSAGES_URL}/${id}${op.suffix}`);
    expect(requests.slice(start)).toEqual([...ids.map(metadataUrl), ...changes]);
    expect(
      google.trashRequests
        .filter((r) => r.method !== "GET")
        .map(({ method, url }) => ({
          method,
          url,
        })),
    ).toEqual(changes.map((url) => ({ method: op.method, url })));
  },
);

it.each(operations)(
  "$name renders all 45 value labels for 15 messages in input order",
  async (op) => {
    serveMessages(ids15);
    const f = await asking(op.name, ids15);
    const response = await f.mcp.browser.get(`/approvals/${f.id}`);
    expect(response.status).toBe(200);
    // Exclude the serialized props: only the page's visible labels prove the rendered view.
    const html = (await response.text()).replace(/<script[\s\S]*?<\/script>/g, "");
    const text = textOf(html);
    let previous = -1;
    for (let position = 1; position <= 15; position++) {
      for (const field of ["from", "subject", "date"]) {
        const label = `Message ${position} ${field}`;
        const index = text.indexOf(label);
        expect(index, label).toBeGreaterThan(previous);
        previous = index;
      }
    }
    if (op.name === "delete_messages") {
      expect(html.indexOf(WARNING)).toBeGreaterThan(html.indexOf("Message 15 date"));
      expect(html.indexOf(WARNING)).toBeLessThan(html.indexOf(">Approve</button>"));
    }
    expect(google.trashRequests.map((r) => r.url)).toEqual(ids15.map(metadataUrl));
    expect(google.methods).toEqual(ids15.map(() => "GET"));
  },
);

it("keeps view values in input order when later metadata answers finish in reverse", async () => {
  const ids = ["m1", "m2", "m3", "m4", "m5"];
  const entered = new Map(ids.map((id) => [id, deferred()]));
  const gates = new Map(ids.map((id) => [id, deferred()]));
  const completed = new Map(ids.map((id) => [id, deferred()]));
  const finished: string[] = [];
  gates.get("m1")!.resolve();
  for (const id of ids) {
    google.trashAnswers.set(id, async () => {
      entered.get(id)!.resolve();
      await gates.get(id)!.promise;
      finished.push(id);
      completed.get(id)!.resolve();
      return Response.json({
        ...message(id),
        payload: {
          headers: [
            { name: "From", value: `${id} <${id}@example.com>` },
            { name: "Subject", value: `Subject ${id}` },
          ],
        },
      });
    });
  }
  const f = await asking("delete_messages", ids);
  const pending = page(f, f.id);
  try {
    await Promise.all([...entered.values()].map((entry) => entry.promise));
    // The first read must finish alone; the concurrent reads then finish in reverse order.
    for (const id of ids.slice(1).toReversed()) {
      gates.get(id)!.resolve();
      await completed.get(id)!.promise;
    }
    expect(finished).toEqual(["m1", "m5", "m4", "m3", "m2"]);
    const props = await pending;
    expect(props.state).toMatchObject({ kind: "waiting", shown: true });
    expect(props.request.values).toEqual(
      ids.flatMap((id, index) => [
        { name: `Message ${index + 1} from`, text: `${id} <${id}@example.com>`, from: "gmail" },
        { name: `Message ${index + 1} subject`, text: `Subject ${id}`, from: "gmail" },
        { name: `Message ${index + 1} date`, text: "Nov 11, 2026 at 09:41 UTC", from: "gmail" },
      ]),
    );
  } finally {
    for (const gate of gates.values()) gate.resolve();
    await pending;
  }
});

it.each(operations)(
  "$name approves 15 messages with 15 page reads, 15 rebuilt reads and 15 changes",
  async (op) => {
    serveMessages(ids15);
    const f = await asking(op.name, ids15);
    const shown = await page(f, f.id);
    if (shown.state.kind !== "waiting") throw new Error("Expected waiting");
    expect(google.trashRequests.map((r) => r.url)).toEqual(ids15.map(metadataUrl));
    expect(google.refreshTokens).toHaveLength(0);
    await env.DB.prepare("UPDATE accounts SET access_expires_at = ? WHERE id = ?")
      .bind(NOW, f.personal.id)
      .run();
    const start = requests.length;
    expect(
      (await decided(await post(f, f.id, "approve", { digest: shown.state.digest! }))).state.kind,
    ).toBe("succeeded");
    expect(google.trashRequests.map(({ method, url }) => ({ method, url }))).toEqual([
      ...[...ids15, ...ids15].map((id) => ({ method: "GET", url: metadataUrl(id) })),
      ...ids15.map((id) => ({ method: op.method, url: `${MESSAGES_URL}/${id}${op.suffix}` })),
    ]);
    expect(google.refreshTokens).toHaveLength(1);
    expect(
      requests.slice(start).filter((url) => new URL(url).hostname.endsWith("googleapis.com")),
    ).toHaveLength(31);
    expect(await get(f, f.id)).toEqual({
      status: "success",
      result: { account: PERSONAL, messages: changed(op.name, ids15) },
    });
  },
);

it("the approved run cut at 25 seconds ends unknown and starts no late change", async () => {
  serveMessages(["m1", "m2"]);
  const f = await asking("delete_messages");
  const shown = await page(f, f.id);
  if (shown.state.kind !== "waiting") throw new Error("Expected waiting");
  // The rebuilt view uses its existing token. The winner then receives an expired credential.
  google.trashAnswers.set("m2", async () => {
    await env.DB.prepare("UPDATE accounts SET access_expires_at = ? WHERE id = ?")
      .bind(NOW, f.personal.id)
      .run();
    return Response.json(message("m2"));
  });
  const entered = deferred(),
    release = deferred(),
    refreshed = deferred();
  const db = observeStatements(
    env.DB,
    async (sql) => {
      if (/UPDATE accounts AS a SET access_token/.test(sql)) {
        entered.resolve();
        await release.promise;
      }
    },
    (sql) => {
      if (/UPDATE accounts AS a SET access_token/.test(sql)) refreshed.resolve();
    },
  );
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let finished = false;
  const running = post(
    f,
    f.id,
    "approve",
    { digest: shown.state.digest! },
    testEnv({ DB: db }),
  ).then((r) => {
    finished = true;
    return r;
  });
  try {
    await entered.promise;
    vi.spyOn(Date, "now").mockReturnValue(NOW + 24_999);
    await vi.advanceTimersByTimeAsync(24_999);
    expect(finished).toBe(false);
    vi.spyOn(Date, "now").mockReturnValue(NOW + 25_000);
    await vi.advanceTimersByTimeAsync(1);
    expect((await decided(await running)).state.kind).toBe("unknown");
    expect(await row(f.id)).toMatchObject({ outcome: "unknown" });
    expect((await callRows())[0]!.outcome).toBeNull();
    expect(await get(f, f.id)).toEqual({ status: "unknown" });
  } finally {
    release.resolve();
    await refreshed.promise;
    await vi.advanceTimersByTimeAsync(1);
    await running;
  }
  expect(google.trashRequests.filter((r) => r.method !== "GET")).toEqual([]);
});

it("keeps an approved delete unknown when its deadline cuts a later change in flight", async () => {
  const ids = ["m1", "m2"];
  serveMessages(ids);
  const f = await asking("delete_messages", ids);
  const shown = await page(f, f.id);
  if (shown.state.kind !== "waiting") throw new Error("Expected waiting");
  const readsEntered = ids.map(() => deferred());
  const readGates = ids.map(() => deferred());
  const changing = deferred(),
    releaseChange = deferred(),
    answered = deferred();
  let changeStarted = false;
  let aborted = false;
  ids.forEach((id, index) =>
    google.trashAnswers.set(id, async (request) => {
      if (request.method === "GET") {
        readsEntered[index]!.resolve();
        await readGates[index]!.promise;
        return Response.json(message(id));
      }
      if (id === "m1") return new Response(null, { status: 204 });
      changeStarted = true;
      request.signal.addEventListener(
        "abort",
        () => {
          aborted = true;
        },
        { once: true },
      );
      changing.resolve();
      await releaseChange.promise;
      answered.resolve();
      return new Response(null, { status: 204 });
    }),
  );
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let finished = false;
  const running = post(f, f.id, "approve", { digest: shown.state.digest! }).then((response) => {
    finished = true;
    return response;
  });
  try {
    // Two real metadata reads use nine seconds each, below their individual ten-second limits.
    for (let index = 0; index < ids.length; index++) {
      await readsEntered[index]!.promise;
      vi.spyOn(Date, "now").mockReturnValue(NOW + (index + 1) * 9000);
      await vi.advanceTimersByTimeAsync(9000);
      readGates[index]!.resolve();
    }
    await changing.promise;
    // changeEach starts m2 only after Gmail has confirmed m1's successful delete.
    expect(google.trashRequests.filter((r) => r.method === "DELETE").map((r) => r.url)).toEqual(
      ids.map((id) => `${MESSAGES_URL}/${id}`),
    );
    vi.spyOn(Date, "now").mockReturnValue(NOW + 24_999);
    await vi.advanceTimersByTimeAsync(6999);
    expect(finished).toBe(false);
    expect(aborted).toBe(false);
    vi.spyOn(Date, "now").mockReturnValue(NOW + 25_000);
    await vi.advanceTimersByTimeAsync(1);
    expect((await decided(await running)).state.kind).toBe("unknown");
    expect(aborted).toBe(true);
    expect(await get(f, f.id)).toEqual({ status: "unknown" });
    expect((await callRows())[0]!.outcome).toBeNull();
    expect(await row(f.id)).toMatchObject({ outcome: "unknown", result: null });
  } finally {
    for (const gate of readGates) gate.resolve();
    releaseChange.resolve();
    if (changeStarted) await answered.promise;
    await vi.advanceTimersByTimeAsync(1);
    await running;
  }
  expect(await get(f, f.id)).toEqual({ status: "unknown" });
  expect((await callRows())[0]!.outcome).toBeNull();
});

it("renders the delete preview at 390 and 1280 pixels without overflow", async () => {
  const preview = previews["approval-waiting-delete"]!;
  if (preview._tag !== "Approval") throw new Error("Expected approval preview");
  expect(preview.request.values).toHaveLength(7);
  expect(preview.request.values.at(-1)).toEqual({
    name: "Message 3 ID, not found in this account",
    text: "19a1b2c3d4e5f603",
    from: "agent",
  });
  expect(preview.request.notes).toEqual([{ text: WARNING, warning: true }]);
  for (const width of [390, 1280]) {
    const response = renderPage(preview);
    const result = await (
      await (env as TestEnv).TEST_BROWSER.fetch("http://browser/hydrate", {
        method: "POST",
        body: JSON.stringify({
          url: `${ORIGIN}/__pages/approval-waiting-delete`,
          html: await response.text(),
          headers: Object.fromEntries(response.headers),
          layout: true,
          width,
        }),
      })
    ).json<{ overflow: boolean; errors: string[] }>();
    expect(result.errors).toEqual([]);
    expect(result.overflow).toBe(false);
  }
}, 60_000);

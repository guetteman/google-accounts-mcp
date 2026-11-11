import { env } from "cloudflare:workers";
import { Effect } from "effect";
import { expect, it, vi } from "vite-plus/test";
import "./support/account-checks";
import { TOOLS, ViewUnavailable } from "../src/mcp/tools";
import { viewDigest } from "../src/approvals/view";
import { NOW } from "./support/accounts";
import { observeStatements, statementFailingDb, dump } from "./support/db";
import { google, deferred, LABELS_RESPONSE } from "./support/google";
import { callRows, fixture, googleTraffic } from "./support/permissions";
import { ask, approve, decided, digest, get, page, post, row, setting } from "./support/approvals";
import { testEnv, textOf } from "./support/worker";
const tool = TOOLS.find((tool) => tool.kind === "account")!;
if (tool.kind !== "account") throw new Error("Missing account tool");

it("shows the whole request in UTC before Approve and covers every displayed value in its digest", async () => {
  const f = await fixture();
  await setting(f, "ask");
  const id = await ask(f);
  const values = [{ name: "Note", text: "Plain text" }];
  vi.spyOn(tool.view, "values").mockReturnValue(Effect.succeed(values));
  const p = await page(f, id);
  expect(p.request).toEqual({
    connection: { id: f.connection.id, name: "Claude", app: "Claude Code" },
    account: { name: "Personal", email: f.personal.email, workspace: false },
    tool: {
      label: "List labels",
      action: "list the Gmail labels",
      joiner: "of",
      empty: "This call has no other values. The sentence above is the whole call.",
    },
    values,
  });
  expect(p.times).toEqual({
    asked: "12:00 UTC",
    askedOn: "Nov 9 at 12:00 UTC",
    expires: "13:00 UTC",
    expiresOn: "Nov 9 at 13:00 UTC",
    minutesSinceAsked: 0,
    minutesLeft: 60,
    decidedOn: null,
  });
  expect(p.state).toMatchObject({
    kind: "waiting",
    shown: true,
    changed: false,
    digest: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  const original = await viewDigest(p.request);
  for (const part of ["connection", "account", "tool"] as const) {
    for (const key of Object.keys(p.request[part])) {
      const changed = structuredClone(p.request);
      const object = changed[part] as Record<string, unknown>;
      object[key] =
        typeof object[key] === "boolean" ? !object[key] : `${String(object[key])} changed`;
      expect(await viewDigest(changed)).not.toBe(original);
    }
  }
  for (const key of ["name", "text"] as const) {
    const changed = structuredClone(p.request);
    changed.values = [{ ...values[0]!, [key]: "changed" }];
    expect(await viewDigest(changed)).not.toBe(original);
  }
  const html = await (await f.mcp.browser.get(`/approvals/${id}`)).text();
  expect(html.indexOf("Plain text")).toBeLessThan(html.indexOf(">Approve</button>"));
  expect(textOf(html)).toContain("list the Gmail labels of");
});
it("renders untrusted values as quoted text and replaces invisible characters", async () => {
  const f = await fixture();
  await setting(f, "ask");
  const id = await ask(f);
  const hidden = [
    "2800",
    "00A0",
    "3000",
    "FFF9",
    "202E",
    "200B",
    "0000",
    "2066",
    "2069",
    "3164",
    "FE0F",
    "034F",
    "115F",
    "1160",
    "17B4",
    "17B5",
    "180B",
    "180F",
    "FFA0",
    "FE00",
    "E0100",
    "E01EF",
  ];
  const characters = hidden.map((code) => String.fromCodePoint(parseInt(code, 16)));
  const text = '<a href="https://evil.example">click</a>' + characters.join("") + "\n\t";
  vi.spyOn(tool.view, "values").mockReturnValue(Effect.succeed([{ name: "Body", text }]));
  const html = (await (await f.mcp.browser.get(`/approvals/${id}`)).text()).replace(
    /<script[\s\S]*?<\/script>/g,
    "",
  );
  expect(html).not.toContain('<a href="https://evil.example">');
  expect(html).toContain("&lt;a");
  for (const code of hidden) expect(html).toContain(`U+${code}`);
  for (const char of characters) expect(html).not.toContain(char);
  expect(html).not.toContain("U+000A");
  expect(html).not.toContain("U+0009");
  expect(html).toContain("<blockquote");
  expect(html).toContain("bg-muted");
});
it("keeps Reject and hides Approve when the view fails, including a submitted Approve", async () => {
  const f = await fixture();
  await setting(f, "ask");
  const id = await ask(f);
  const previous = await digest(f, id);
  vi.spyOn(tool.view, "values").mockReturnValue(Effect.fail(new ViewUnavailable()));
  expect((await page(f, id)).state).toEqual({
    kind: "waiting",
    shown: false,
    changed: false,
    digest: null,
  });
  const text = textOf(await (await f.mcp.browser.get(`/approvals/${id}`)).text());
  expect(text).toContain("The server could not show this call.");
  const html = await (await f.mcp.browser.get(`/approvals/${id}`)).text();
  expect(html).not.toContain(">Approve</button>");
  expect(html).toContain(">Reject</button>");
  const forms: Record<string, string>[] = [{ digest: previous }, {}, { digest: "" }];
  for (const form of forms) {
    expect((await decided(await post(f, id, "approve", form))).state).toMatchObject({
      kind: "waiting",
      shown: false,
    });
    expect((await row(id))!.state).toBe("waiting");
  }
  expect(google.labelRequests).toEqual([]);
  expect((await decided(await post(f, id, "reject"))).state.kind).toBe("rejected");
});
it("returns a changed view and runs nothing for a stale digest", async () => {
  const f = await fixture();
  await setting(f, "ask");
  const id = await ask(f);
  const previous = await digest(f, id);
  await f.mcp.browser.post(`/accounts/${f.personal.id}/name`, { name: "Renamed" });
  const answer = await decided(await post(f, id, "approve", { digest: previous }));
  expect(answer.state).toMatchObject({ kind: "waiting", shown: true, changed: true });
  expect(answer.request.account.name).toBe("Renamed");
  expect(google.labelRequests).toEqual([]);
});
it("two concurrent Approves at the same millisecond execute once and expose running during the call", async () => {
  const f = await fixture();
  await setting(f, "ask");
  const id = await ask(f);
  const d = await digest(f, id);
  const entered = deferred(),
    release = deferred();
  google.labelAnswers.push(async () => {
    entered.resolve();
    await release.promise;
    return Response.json(LABELS_RESPONSE);
  });
  const first = post(f, id, "approve", { digest: d });
  await entered.promise;
  expect((await page(f, id)).state.kind).toBe("running");
  expect(await get(f, id)).toMatchObject({
    status: "running",
    message: expect.stringContaining("few seconds"),
  });
  expect((await decided(await post(f, id, "approve", { digest: d }))).state.kind).toBe("running");
  const stored = await row(id);
  expect(stored).toMatchObject({ decided_at: NOW, state: "approved", arguments: null });
  expect((await callRows()).find((call) => call.tool === "list_labels")!.outcome).toBeNull();
  release.resolve();
  expect((await decided(await first)).state.kind).toBe("succeeded");
  expect(google.labelRequests).toHaveLength(1);
});
it("concurrent Approve and Reject count one decision and agree after Reject wins", async () => {
  const f = await fixture();
  await setting(f, "ask");
  const id = await ask(f);
  const entered = deferred(),
    release = deferred();
  vi.spyOn(tool.view, "values").mockImplementationOnce(() =>
    Effect.promise(async () => {
      entered.resolve();
      await release.promise;
      return [];
    }),
  );
  const first = post(f, id, "approve", { digest: "unused after rejection" });
  await entered.promise;
  const rejection = await decided(await post(f, id, "reject"));
  release.resolve();
  const approval = await decided(await first);
  // A stale digest must return the current persisted decision, not revive a waiting view.
  expect(rejection.state.kind).toBe("rejected");
  expect(approval.state.kind).toBe("rejected");
  expect(google.labelRequests).toEqual([]);
});
it.each([
  { action: "approve", committed: false },
  { action: "approve", committed: true },
  { action: "reject", committed: false },
  { action: "reject", committed: true },
] as const)(
  "returns unconfirmed on a lost $action decision response, committed=$committed, without guessing or retrying",
  async ({ action, committed }) => {
    const f = await fixture();
    await setting(f, "ask");
    const id = await ask(f);
    const d = await digest(f, id);
    const pattern = new RegExp(
      `UPDATE approvals SET state = '${action === "approve" ? "approved" : "rejected"}'`,
    );
    let attempts = 0;
    const db = observeStatements(
      env.DB,
      (sql) => {
        if (pattern.test(sql)) {
          attempts++;
          if (!committed) throw new Error("before commit");
        }
      },
      (sql) => {
        if (committed && pattern.test(sql)) throw new Error("after commit");
      },
    );
    const response = await post(f, id, action, { digest: d }, testEnv({ DB: db }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ outcome: "unknown" });
    expect(attempts).toBe(1);
    expect(google.labelRequests).toEqual([]);
    expect((await row(id))!.state).toBe(
      committed ? (action === "approve" ? "approved" : "rejected") : "waiting",
    );
    if (!committed) {
      expect((await approve(f, id)).state.kind).toBe("succeeded");
      expect(google.labelRequests).toHaveLength(1);
      google.labelRequests.length = 0;
    } else {
      await post(f, id, "approve", { digest: d });
      await post(f, id, "reject");
      expect(google.labelRequests).toEqual([]);
      vi.spyOn(Date, "now").mockReturnValue(NOW + 30_000);
      expect(await get(f, id)).toEqual({ status: action === "approve" ? "unknown" : "rejected" });
      vi.spyOn(Date, "now").mockReturnValue(NOW);
    }
  },
);
it("rolls back Reject, argument deletion and audit together when the audit write fails", async () => {
  const f = await fixture();
  await setting(f, "ask");
  const id = await ask(f);
  const before = await row(id);
  await env.DB.prepare(
    "CREATE TRIGGER fail_reject BEFORE UPDATE OF outcome ON calls WHEN NEW.outcome = 'rejected' BEGIN SELECT RAISE(ABORT, 'test rollback'); END",
  ).run();
  const response = await post(f, id, "reject");
  expect(response.status).toBe(503);
  expect(await row(id)).toEqual(before);
  expect((await callRows())[0]!.outcome).toBe("pending");
});
it("allows a waiting ask call only on Approve after the setting becomes allow", async () => {
  const f = await fixture();
  await setting(f, "ask");
  const id = await ask(f);
  await setting(f, "allow");
  expect(await get(f, id)).toMatchObject({ status: "pending" });
  expect(google.labelRequests).toEqual([]);
  expect((await approve(f, id)).state.kind).toBe("succeeded");
});
it("requires the owner's same-origin identity for both decision actions", async () => {
  const f = await fixture();
  await setting(f, "ask");
  const id = await ask(f);
  const d = await digest(f, id);
  const before = await dump();
  const traffic = googleTraffic().length;
  for (const action of ["approve", "reject"])
    for (const origin of [null, "https://evil.example"])
      expect(
        (await f.mcp.browser.post(`/approvals/${id}/${action}`, { digest: d }, { origin })).status,
      ).toBe(403);
  expect(await dump()).toEqual(before);
  expect(googleTraffic().slice(traffic)).toEqual([]);
});
it("returns the same private not-found response for invalid and missing approval IDs", async () => {
  const f = await fixture();
  for (const id of ["not-an-id", crypto.randomUUID()]) {
    expect((await f.mcp.browser.get(`/approvals/${id}`)).status).toBe(404);
    for (const action of ["approve", "reject"] as const) {
      const response = await post(f, id, action);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ outcome: "not_found" });
    }
  }
});
it("reads the page in one settling batch and reports uncertainty if its response is lost", async () => {
  const f = await fixture();
  await setting(f, "ask");
  const id = await ask(f);
  const db = statementFailingDb(/UPDATE approvals SET outcome = 'unknown'/);
  expect((await f.mcp.browser.get(`/approvals/${id}`, { env: testEnv({ DB: db }) })).status).toBe(
    503,
  );
});

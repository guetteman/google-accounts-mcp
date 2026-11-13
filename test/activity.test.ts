import { env } from "cloudflare:workers";
import { expect, it, vi } from "vite-plus/test";
import { seedAccount } from "./support/accounts";
import { access } from "./support/access";
import { activityFixture, activityProps, approval, link, record } from "./support/activity";
import { Browser } from "./support/browser";
import { NOW, seedConnection } from "./support/connections";
import { dump, setOwner, statementFailingDb } from "./support/db";
import { OWNER_EMAIL, testEnv, textOf } from "./support/worker";

// Make the real menu links observable during SSR, as pages.test.ts does for the owner menu.
vi.hoisted(() => vi.resetModules());
vi.mock("../src/components/ui/dropdown-menu", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/components/ui/dropdown-menu")>();
  return {
    ...actual,
    DropdownMenuContent: ({ children }: { children: import("react").ReactNode }) => children,
    DropdownMenuItem: ({ children }: { children: import("react").ReactNode }) => children,
  };
});

it("uses the same owner gate as Connections for missing, invalid, foreign, unavailable and locked identities", async () => {
  const browser = new Browser();
  const check = async (status: number, workerEnv = testEnv()) => {
    const activity = await browser.get("/activity", { env: workerEnv });
    const connections = await browser.get("/connections", { env: workerEnv });
    expect(activity.status).toBe(status);
    expect(textOf(await activity.text())).toBe(textOf(await connections.text()));
  };
  await check(403);
  browser.assertion = "invalid";
  await check(403);
  await browser.authenticate({ email: "someone.else@example.net" });
  await check(403);
  const issuer = "https://activity-outage.cloudflareaccess.com";
  await browser.authenticate({ iss: issuer });
  access.mode = "fail";
  await check(503, testEnv({ ACCESS_ISSUER: issuer }));
  access.mode = "ok";
  await setOwner({ state: "pinned", generation: 1, email: OWNER_EMAIL });
  await browser.authenticate();
  await check(503, testEnv({ OWNER_EMAIL: "changed@example.com" }));
});

it("walks 56 records by ID in loads of 25 and reaches the oldest without skips or duplicates", async () => {
  const f = await activityFixture();
  await env.DB.prepare(`WITH RECURSIVE n(id) AS (VALUES(1) UNION ALL SELECT id+1 FROM n WHERE id<56)
    INSERT INTO calls (id,connection_id,account_id,tool,at,outcome)
    SELECT id,?,?,'read_thread',? - id*60000,'success' FROM n`)
    .bind(f.connection.id, f.account.id, NOW)
    .run();
  let path: string | null = "/activity";
  const all: number[] = [];
  for (const [page, expected] of [
    [0, Array.from({ length: 25 }, (_, i) => 56 - i)],
    [1, Array.from({ length: 25 }, (_, i) => 31 - i)],
    [2, [6, 5, 4, 3, 2, 1]],
  ] as const) {
    const response = await f.browser.get(path!);
    expect(response.status).toBe(200);
    const html = await response.text();
    const props = activityProps(html);
    expect(props.load.records.map((r) => r.id)).toEqual(expected);
    // Arrival times run in the opposite order; assert the actual rendered rows too.
    const visible = [
      ...new Set(
        [...html.matchAll(/<time dateTime="([^"]+)"/g)].map(
          (m) => (NOW - Date.parse(m[1]!)) / 60000,
        ),
      ),
    ];
    expect(visible).toEqual(expected);
    expect(link(html, "Back to newest")).toBe(page === 0 ? null : "/activity");
    all.push(...props.load.records.map((r) => r.id));
    path = link(html, "Older");
  }
  expect(path).toBeNull();
  expect(all).toEqual(Array.from({ length: 56 }, (_, i) => 56 - i));
});

it("shows stored times in UTC, other accounts, absent accounts/tools, and every outcome without changing D1", async () => {
  const f = await activityFixture();
  const source = await seedAccount({ name: "Northwind", email: "alex@northwind.example" });
  const removed = await seedAccount({
    name: "Old work",
    email: "alex@old.example",
    state: "removed",
    removed_at: NOW - 86400000,
    access_token: null,
    refresh_token: null,
  });
  const ended = await seedConnection({
    name: "Old laptop",
    state: "revoked",
    revoked_at: NOW - 86400000,
  });
  const expired = await seedConnection({ name: "Expired laptop", expires_at: NOW - 86400000 });
  const outcomes = [
    "success",
    "pending",
    "refused",
    "failed",
    "rejected",
    "expired",
    "repeat",
    null,
  ];
  for (const [i, outcome] of outcomes.entries())
    await record(f.connection.id, f.account.id, { outcome, at: NOW - i * 60000 });
  await record(f.connection.id, f.account.id, {
    tool: "send_message",
    also: [
      { account: source.id, tool: "get_attachment" },
      { account: removed.id, tool: "get_attachment" },
    ],
    at: NOW - 86400000,
  });
  for (const tool of ["list_accounts", "get_approval", "create_upload_link", "read_thread", null])
    await record(f.connection.id, null, { tool, outcome: tool === null ? "refused" : "success" });
  await record(ended.id, removed.id);
  await record(expired.id, f.account.id);
  const before = await dump();
  const response = await f.browser.get("/activity");
  expect(response.status).toBe(200);
  const html = await response.text();
  const props = activityProps(html);
  expect(textOf(html)).toContain("Times are in UTC.");
  expect(props.load.records.find((r) => r.id === 1)?.time).toEqual({
    iso: "2030-11-09T12:00:00.000Z",
    short: "12:00",
    full: "Sat, Nov 9, 2030 at 12:00 UTC",
    today: true,
  });
  const copied = props.load.records.find((r) => r.tool?.name === "send_message")!;
  expect(copied.time.short).toBe("Nov 8, 12:00");
  expect(copied.also.map((a) => [a.account.name, a.tool.label])).toEqual([
    ["Northwind", "Download attachment"],
    ["Old work", "Download attachment"],
  ]);
  expect(textOf(html)).toContain("+2");
  expect(props.load.records.filter((r) => r.account === null)).toHaveLength(5);
  expect(textOf(html).match(/No account/g)).toHaveLength(1);
  expect(textOf(html)).toContain("No such tool");
  for (const label of ["List accounts", "Get approval result", "Create upload link"])
    expect(textOf(html)).toContain(label);
  for (const [i, label] of [
    "Done",
    "Waiting",
    "Refused",
    "Failed",
    "Rejected",
    "Expired",
    "Repeat",
    "Unknown",
  ].entries()) {
    const row = props.load.records.find((r) => r.id === i + 1)!;
    expect(row.outcome).toBe(outcomes[i] ?? "unknown");
    expect(html).toContain(`aria-label="${label}: Read thread, ${row.time.short}. Show details"`);
  }
  expect(textOf(html)).toMatch(/Old work\s*removed/);
  expect(textOf(html)).toMatch(/Old laptop\s*ended/);
  expect(props.load.connections.find((c) => c.id === ended.id)?.status).toEqual({
    kind: "revoked",
    on: "Nov 8",
  });
  expect(props.load.connections.find((c) => c.id === expired.id)?.status).toEqual({
    kind: "expired",
    on: "Nov 8",
  });
  expect(props.load.accounts.find((a) => a.id === removed.id)?.removedOn).toBe("Nov 8");
  expect(await dump()).toEqual(before);
  // Today follows the UTC date even on a host in another time zone; old years remain visible.
  vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2030, 10, 10, 0, 1));
  await f.browser.authenticate();
  await record(f.connection.id, f.account.id, { at: Date.UTC(2030, 10, 9, 23, 59) });
  await record(f.connection.id, f.account.id, { at: Date.UTC(2029, 11, 31, 23, 59) });
  const later = activityProps(await (await f.browser.get("/activity")).text()).load.records;
  expect(later[0]!.time.short).toBe("Dec 31, 2029, 23:59");
  expect(later[1]!.time.short).toBe("Nov 9, 23:59");
});

it("keeps a retired tool's stored name readable without hiding the other records", async () => {
  const f = await activityFixture();
  await record(f.connection.id, f.account.id);
  await record(f.connection.id, null, { tool: "retired_read_mail", outcome: "refused" });
  const response = await f.browser.get("/activity");
  expect(response.status).toBe(200);
  const html = await response.text();
  const records = activityProps(html).load.records;
  expect(records.map((r) => r.id)).toEqual([2, 1]);
  expect(records[0]!.tool).toEqual({
    name: "retired_read_mail",
    label: "retired_read_mail",
    kind: "account",
  });
  expect(textOf(html)).toContain("retired_read_mail");
  expect(textOf(html)).toContain("No account");
});

it.each([
  ["refused", "tool_not_allowed", "Tool not allowed"],
  ["failed", "account_needs_reconnect", "Account needs reconnect"],
  ["failed", "new_failure", "new_failure"],
  ["refused", "toString", "toString"],
  ["failed", "constructor", "constructor"],
  ["refused", null, null],
  ["failed", null, null],
])("shows %s reason %s as %s, and omits an absent reason", async (outcome, reason, label) => {
  const f = await activityFixture();
  await record(f.connection.id, f.account.id, { outcome, reason });
  const response = await f.browser.get("/activity");
  expect(response.status).toBe(200);
  const html = await response.text();
  expect(activityProps(html).load.records[0]!.reason).toBe(label);
  const records = html.split('aria-label="Records"')[1]!.split("</ul>")[0]!;
  if (label === null) expect(records).not.toMatch(/<p\b/);
  else expect(records).toMatch(new RegExp(`<p[^>]*>${label}</p>`));
});

it.each([
  ["tool", "You set a tool to Not allowed while it waited"],
  ["connection", "You revoked the connection while it waited"],
  ["account", "You removed an account while it waited"],
] as const)("shows the owner change %s even without a stored reason", async (by, label) => {
  const f = await activityFixture();
  const call = await record(f.connection.id, f.account.id, { outcome: "refused" });
  await approval(call, f.connection.id, "refused", NOW + 3600000, by);
  const html = await (await f.browser.get("/activity")).text();
  expect(activityProps(html).load.records[0]!.reason).toBe(label);
  expect(html).toMatch(new RegExp(`<p[^>]*>${label}</p>`));
  expect(await env.DB.prepare("SELECT reason FROM calls WHERE id = ?").bind(call).first()).toEqual({
    reason: null,
  });
});

it("links only pending records, keeps expired pending links and reads each approval's decision", async () => {
  const f = await activityFixture();
  const outcomes = [
    "pending",
    "success",
    "rejected",
    null,
    "expired",
    "repeat",
    "failed",
    "refused",
  ];
  const ids: string[] = [];
  for (const [i, outcome] of outcomes.entries()) {
    const call = await record(f.connection.id, f.account.id, { outcome });
    ids.push(
      await approval(
        call,
        f.connection.id,
        i === 2 ? "rejected" : i === 0 ? "waiting" : "approved",
        NOW - 1,
      ),
    );
  }
  // An approval of a different connection must never be attached to this record.
  const other = await seedConnection();
  const call = await record(f.connection.id, f.account.id, { outcome: "pending" });
  await approval(call, other.id);
  const before = await dump();
  const html = await (await f.browser.get("/activity")).text();
  expect([...html.matchAll(/href="\/approvals\/([^"]+)"/g)].map((m) => m[1])).toEqual([ids[0]]);
  const records = activityProps(html).load.records;
  expect(records.find((r) => r.id === 1)?.approval).toMatchObject({
    id: ids[0],
    state: "waiting",
    decidedOn: null,
  });
  expect(records.find((r) => r.id === 2)?.approval).toMatchObject({
    state: "approved",
    decidedOn: "Sat, Nov 9, 2030 at 11:59 UTC",
  });
  expect(records.find((r) => r.id === 3)?.approval).toMatchObject({
    state: "rejected",
    decidedOn: "Sat, Nov 9, 2030 at 11:59 UTC",
  });
  expect(records.find((r) => r.id === call)?.approval).toBeNull();
  expect(await dump()).toEqual(before);
});

it("filters by exactly one URL value, includes secondary accounts and builds links that clear every other choice and position", async () => {
  const f = await activityFixture();
  const ended = await seedConnection({ name: "Ended", expires_at: NOW - 1 });
  const removed = await seedAccount({
    name: "Removed",
    email: "removed@example.com",
    state: "removed",
    removed_at: NOW - 86400000,
    access_token: null,
    refresh_token: null,
  });
  await record(f.connection.id, f.account.id, {
    also: [{ account: removed.id, tool: "get_attachment" }],
    outcome: null,
  });
  await record(ended.id, removed.id, { outcome: "failed" });
  await record(f.connection.id, f.account.id, { outcome: "success" });
  for (const [query, expected] of [
    [`connection=${ended.id}`, [2]],
    [`account=${removed.id}`, [2, 1]],
    ["outcome=unknown", [1]],
    ["outcome=success", [3]],
    [`connection=${f.connection.id}&account=${removed.id}&outcome=failed`, [3, 1]],
    [`connection=bad&account=${removed.id}&outcome=success`, [2, 1]],
    ["connection=bad&account=bad&outcome=failed", [2]],
    ["connection=bad&account=bad&outcome=nope&before=0", [3, 2, 1]],
    ["before=2", [1]],
  ] as const) {
    const path = `/activity?${query}`;
    const html = await (await f.browser.get(path)).text();
    expect(
      activityProps(html).load.records.map((r) => r.id),
      path,
    ).toEqual(expected);
    expect(
      activityProps(await (await f.browser.get(path)).text()).load.records.map((r) => r.id),
    ).toEqual(expected);
  }
  for (const before of ["-1", "1.5", "1e2", "NaN", "9007199254740992", "1 OR 1=1"]) {
    const props = activityProps(
      await (await f.browser.get(`/activity?before=${encodeURIComponent(before)}`)).text(),
    );
    expect(props.query.before).toBeNull();
    expect(props.load.records.map((r) => r.id)).toEqual([3, 2, 1]);
  }
  const html = await (await f.browser.get(`/activity?account=${removed.id}&before=3`)).text();
  for (const match of html.matchAll(/href="(\/activity[^"]*)"/g)) {
    const url = new URL(match[1]!.replaceAll("&amp;", "&"), "https://example.com");
    expect([...url.searchParams.keys()].filter((k) => k !== "before").length).toBeLessThanOrEqual(
      1,
    );
    expect(url.searchParams.has("before")).toBe(false);
  }
  expect(link(html, "Waiting")).toBe("/activity?outcome=pending");
  expect(html).toMatch(/href="\/activity" aria-current="true"[^>]*>All<\/a>/);
  expect(html).toContain(`href="/activity?connection=${ended.id}"`);
  expect(html).toContain(`href="/activity?account=${removed.id}"`);
  expect(textOf(html)).toContain("Removed Nov 8");
  expect(textOf(html)).toContain("Ended");
  expect(link(html, "Back to newest")).toBe(`/activity?account=${removed.id}`);
  const connectionHtml = await (await f.browser.get(`/connections/${f.connection.id}`)).text();
  expect(link(connectionHtml, "See its activity")).toBe(`/activity?connection=${f.connection.id}`);
});

it("distinguishes an empty log from a filter with no match, including well-formed missing IDs", async () => {
  const f = await activityFixture();
  expect(textOf(await (await f.browser.get("/activity")).text())).toContain("No activity yet");
  await record(f.connection.id, f.account.id);
  for (const query of [
    "outcome=failed",
    `connection=${crypto.randomUUID()}`,
    `account=${crypto.randomUUID()}`,
  ]) {
    const html = await (await f.browser.get(`/activity?${query}`)).text();
    expect(activityProps(html).load.records).toEqual([]);
    expect(textOf(html)).toContain("No records match this filter");
    expect(link(html, "Clear filter")).toBe("/activity");
  }
});

it("answers with the existing unavailable page if the Activity batch fails", async () => {
  const f = await activityFixture();
  const db = statementFailingDb(/LEFT JOIN approvals p/);
  const response = await f.browser.get("/activity", { env: testEnv({ DB: db }) });
  expect(response.status).toBe(503);
  expect(textOf(await response.text())).toContain("The server can't reach its database");
});

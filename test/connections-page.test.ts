import { expect, it, vi } from "vite-plus/test";
import { Browser } from "./support/browser";
import {
  NOW,
  onlyConnection,
  pinOwner,
  resetOwner,
  rows,
  seedConnection,
} from "./support/connections";
import {
  brokenDb,
  dump,
  kvDump,
  racingConnectionWriteDb,
  responseLostConnectionWriteDb,
  setOwner,
  statementFailingDb,
} from "./support/db";
import { McpClient } from "./support/oauth";
import { ORIGIN, OWNER_EMAIL, testEnv, textOf } from "./support/worker";

async function ownerBrowser() {
  const browser = new Browser();
  await browser.authenticate();
  return browser;
}
function tableRows(html: string) {
  const body = /<tbody\b[^>]*>([\s\S]*?)<\/tbody>/.exec(html)?.[1];
  expect(body, "desktop Connections table must exist").toBeDefined();
  return [...body!.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => m[1]!);
}

it("lists every current-generation connection with active newest first then most recently ended", async () => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  await setOwner({ state: "pinned", generation: 3, email: OWNER_EMAIL });
  await seedConnection({ generation: 2, name: "Old owner connection" });
  await seedConnection({ generation: 3, name: "Shared name", created_at: NOW - 10_000 });
  await seedConnection({
    generation: 3,
    name: "Shared name",
    app: "chatgpt",
    created_at: NOW - 1_000,
  });
  await seedConnection({
    generation: 3,
    name: "Ended earlier",
    app: "claude-hosted",
    state: "revoked",
    revoked_at: NOW - 8_000,
  });
  await seedConnection({ generation: 3, name: "Ended recently", expires_at: NOW - 2_000 });
  const browser = await ownerBrowser();
  const response = await browser.get("/connections");
  expect(response.status).toBe(200);
  const html = await response.text();
  expect(textOf(html)).not.toContain("Old owner connection");
  const listed = tableRows(html).map(textOf);
  expect(listed).toHaveLength(4);
  expect(listed[0]).toContain("Shared name ChatGPT Active");
  expect(listed[1]).toContain("Shared name Claude Code Active");
  expect(listed[2]).toContain("Ended recently");
  expect(listed[3]).toContain("Ended earlier Claude Revoked");
  for (const title of ["Name", "App", "Status", "Last used", "Can see"])
    expect(textOf(html)).toContain(title);
  for (const row of listed) expect(row).toContain("Never");
});

it("formats last use in UTC and links connections without action menus", async () => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  await pinOwner();
  await seedConnection({
    name: "Active laptop",
    created_at: Date.parse("2030-11-06T00:30:00Z"),
    last_used_at: Date.parse("2025-11-06T23:30:00Z"),
  });
  await seedConnection({
    name: "Revoked laptop",
    state: "revoked",
    revoked_at: Date.parse("2030-09-14T00:30:00Z"),
    created_at: Date.parse("2025-11-06T00:30:00Z"),
  });
  await seedConnection({ name: "Expired laptop", expires_at: Date.parse("2030-11-06T00:30:00Z") });
  const html = await (await (await ownerBrowser()).get("/connections")).text();
  const listed = tableRows(html);
  const active = listed.find((r) => textOf(r).includes("Active laptop"))!;
  expect(textOf(active)).toContain("Nov 6, 2025");
  const cells = [...active.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map((cell) =>
    textOf(cell[1]!),
  );
  expect(cells[3]).toBe("Nov 6, 2025");
  expect(cells[4]).toMatch(/no access yet/i);
  expect(active).toMatch(/href="\/connections\/[^"]+"/);
  expect(active).not.toMatch(/<button\b|role="menu"/);
  for (const [name, status] of [
    ["Revoked laptop", "Revoked Sep 14"],
    ["Expired laptop", "Expired Nov 6"],
  ]) {
    const row = listed.find((r) => textOf(r).includes(name!));
    expect(row).toBeDefined();
    expect(textOf(row!)).toContain(status);
    expect(textOf(row!)).toContain("Never");
    expect(row).not.toMatch(/<button\b|role="menu"/);
  }
});

it("renames an active connection by changing only its trimmed name", async () => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  await pinOwner();
  const row = await seedConnection();
  await seedConnection({ name: "Another laptop" });
  const before = await dump();
  const browser = await ownerBrowser();
  const response = await browser.post(`/connections/${row.id}/name`, {
    name: "  Personal laptop  ",
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ outcome: "ok" });
  const expected = structuredClone(before);
  const connection = (expected.connections as Array<Record<string, unknown>>).find(
    (r) => r.id === row.id,
  )!;
  connection.name = "Personal laptop";
  expect(await dump()).toEqual(expected);
});

it.each(["revoked", "expired"])(
  "leaves an already %s connection unchanged on rename and revoke",
  async (state) => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    await pinOwner();
    const row = await seedConnection(
      state === "revoked" ? { state: "revoked", revoked_at: NOW - 1 } : { expires_at: NOW },
    );
    const browser = await ownerBrowser();
    const before = await dump();
    for (const action of ["name", "revoke"]) {
      const response = await browser.post(`/connections/${row.id}/${action}`, {
        name: "Personal laptop",
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ outcome: "already_ended" });
      expect(await dump()).toEqual(before);
    }
  },
);

it("returns not found for unknown connection actions without changing anything", async () => {
  await pinOwner();
  await seedConnection();
  const browser = await ownerBrowser();
  const before = await dump();
  for (const action of ["name", "revoke"]) {
    const response = await browser.post(`/connections/${crypto.randomUUID()}/${action}`, {
      name: "Personal laptop",
    });
    expect(response.status).toBe(404);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(await response.json()).toEqual({ outcome: "not_found" });
    expect(await dump()).toEqual(before);
  }
});

it.each([
  { label: "blank", name: " " },
  { label: "over one hundred letters", name: "a".repeat(101) },
  { label: "over one hundred emoji", name: "😀".repeat(101) },
])("refuses a $label rename without any changes", async ({ name }) => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  await pinOwner();
  const row = await seedConnection();
  const browser = await ownerBrowser();
  const before = await dump();
  const response = await browser.post(`/connections/${row.id}/name`, { name });
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ outcome: "invalid" });
  expect(await dump()).toEqual(before);
});

it("accepts a rename of exactly one hundred Unicode code points", async () => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  await pinOwner();
  const row = await seedConnection();
  const name = "😀".repeat(100);
  const response = await (
    await ownerBrowser()
  ).post(`/connections/${row.id}/name`, { name: `  ${name} ` });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ outcome: "ok" });
  expect((await onlyConnection()).name).toBe(name);
});

it("marks revoke at the current time and cleans up only that grant afterwards", async () => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  const mcp = await new McpClient().connect();
  const row = await onlyConnection();
  const other = await new McpClient().connect();
  const before = await rows();
  const kv = await kvDump();
  const response = await mcp.browser.post(`/connections/${row.id}/revoke`);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ outcome: "ok" });
  expect(await rows()).toEqual(
    before.map((r) => (r.id === row.id ? { ...r, state: "revoked", revoked_at: NOW } : r)),
  );
  expect(await kvDump()).toEqual(
    kv.filter(
      (e) => !e.name.startsWith(`grant:${row.id}:`) && !e.name.startsWith(`token:${row.id}:`),
    ),
  );
  expect((await other.call()).status).toBe(200);
});

it.each(["database outage", "owner mismatch"])(
  "reports a gate refusal during %s without changing any data",
  async (failure) => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    await pinOwner();
    const row = await seedConnection();
    const browser = await ownerBrowser();
    const before = await dump();
    const workerEnv = testEnv(
      failure === "database outage" ? { DB: brokenDb() } : { OWNER_EMAIL: "new.owner@example.com" },
    );
    for (const action of ["name", "revoke"]) {
      const response = await browser.post(
        `/connections/${row.id}/${action}`,
        { name: "Personal laptop" },
        { env: workerEnv },
      );
      expect(response.status).toBe(503);
      expect(response.headers.get("Content-Type")).toContain("text/html");
      expect(await dump()).toEqual(before);
    }
  },
);

it("reports connection read failures as unavailable before any write", async () => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  await pinOwner();
  await seedConnection();
  const browser = await ownerBrowser();
  const before = await dump();
  // A zero-row UPDATE is followed by an outcome read; only that read fails.
  const response = await browser.post(
    `/connections/${crypto.randomUUID()}/revoke`,
    {},
    { env: testEnv({ DB: statementFailingDb(/^\s*SELECT.*connections/is) }) },
  );
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ outcome: "unavailable" });
  expect(await dump()).toEqual(before);
});

it.each(["name", "revoke"])(
  "reports an uncertain %s write and reloads the actual D1 state",
  async (action) => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    await pinOwner();
    const row = await seedConnection();
    const browser = await ownerBrowser();
    const before = await dump();
    const response = await browser.post(
      `/connections/${row.id}/${action}`,
      { name: "Personal laptop" },
      { env: testEnv({ DB: statementFailingDb(/^\s*UPDATE\s+connections/i) }) },
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ outcome: "unknown" });
    expect(await dump()).toEqual(before);
    const reloaded = await browser.get("/connections");
    expect(reloaded.status).toBe(200);
    expect(textOf(await reloaded.text())).toContain("Work laptop");
  },
);

it("returns not found for actions from a page loaded before reset", async () => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  await pinOwner();
  const row = await seedConnection();
  const browser = await ownerBrowser();
  expect((await browser.get("/connections")).status).toBe(200);
  await resetOwner();
  expect((await browser.get("/accounts")).status).toBe(200);
  const fresh = await seedConnection({ generation: 2, name: "Fresh laptop" });
  const before = await dump();
  for (const action of ["name", "revoke"]) {
    const response = await browser.post(`/connections/${row.id}/${action}`, {
      name: "Personal laptop",
    });
    expect(response.status).toBe(404);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(await response.json()).toEqual({ outcome: "not_found" });
    expect(await dump()).toEqual(before);
  }
  expect(await onlyConnection()).toEqual(fresh);
});

for (const action of ["name", "revoke"]) {
  it.each(["generation", "email"])(
    `guards each ${action} statement when owner %s changes after verification`,
    async (field) => {
      vi.spyOn(Date, "now").mockReturnValue(NOW);
      await pinOwner();
      const row = await seedConnection();
      const browser = await ownerBrowser();
      const db = racingConnectionWriteDb(() =>
        setOwner({
          state: "pinned",
          generation: field === "generation" ? 2 : 1,
          email: field === "email" ? "new.owner@example.com" : OWNER_EMAIL,
        }),
      );
      const response = await browser.post(
        `/connections/${row.id}/${action}`,
        { name: "Personal laptop" },
        { env: testEnv({ DB: db }) },
      );
      expect(response.status).not.toBe(500);
      expect(response.headers.get("Content-Type")).toContain("application/json");
      expect(await response.json()).not.toEqual({ outcome: "ok" });
      expect(await onlyConnection()).toEqual(row);
    },
  );
}

it("shows the deploy MCP URL and Copy button when there are no connections", async () => {
  const browser = await ownerBrowser();
  const response = await browser.get("/connections");
  expect(response.status).toBe(200);
  const html = await response.text();
  const text = textOf(html);
  expect(html).toContain(`${ORIGIN}/mcp`);
  expect(text).toContain(
    "Add this server in Claude, Claude Code, or ChatGPT. Each app that signs in appears here.",
  );
  const buttons = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gi)];
  expect(
    buttons.some(
      (button) =>
        /aria-label="[^"]*\bCopy\b[^"]*"/i.test(button[1]!) || /\bCopy\b/.test(textOf(button[2]!)),
    ),
  ).toBe(true);
});

it("reports an uncertain response after a committed rename and reloads the changed name", async () => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  await pinOwner();
  const row = await seedConnection();
  const browser = await ownerBrowser();
  const response = await browser.post(
    `/connections/${row.id}/name`,
    { name: "Personal laptop" },
    { env: testEnv({ DB: responseLostConnectionWriteDb() }) },
  );
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ outcome: "unknown" });
  expect((await onlyConnection()).name).toBe("Personal laptop");
  expect(textOf(await (await browser.get("/connections")).text())).toContain("Personal laptop");
});

import { env } from "cloudflare:workers";
import { expect, it, onTestFinished, vi } from "vite-plus/test";
import { POLL_MS, TICKS } from "../src/mcp/watch";
import { NOW, resetOwner } from "./support/connections";
import { observeStatements } from "./support/db";
import { deferred } from "./support/google";
import { McpClient } from "./support/oauth";
import { fixture, permission } from "./support/permissions";
import { callWorker, ORIGIN, testEnv } from "./support/worker";

const acknowledged = {
  jsonrpc: "2.0",
  method: "notifications/subscriptions/acknowledged",
  params: {
    notifications: { toolsListChanged: true },
    _meta: { "io.modelcontextprotocol/subscriptionId": 1 },
  },
};
const changed = {
  jsonrpc: "2.0",
  method: "notifications/tools/list_changed",
  params: { _meta: { "io.modelcontextprotocol/subscriptionId": 1 } },
};
const complete = {
  jsonrpc: "2.0",
  id: 1,
  result: {
    resultType: "complete",
    _meta: {
      "io.modelcontextprotocol/subscriptionId": 1,
      "io.modelcontextprotocol/serverInfo": { name: "google-accounts-mcp", version: "0.0.0" },
    },
  },
};
const isList = (sql: string) => /SELECT json_group_array\(tool\)/.test(sql);

/** Observe real D1 completion before advancing to the next chained timer. */
async function listen(mcp: McpClient, failBaseline = false) {
  if (!vi.isFakeTimers()) vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let read = deferred();
  const control = {
    queries: 0,
    kvOperations: 0,
    listReads: 0,
    failNext: failBaseline,
    holdNext: undefined as
      | { entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> }
      | undefined,
    nextRead() {
      read = deferred();
      return read.promise;
    },
  };
  const DB = observeStatements(
    env.DB,
    async (sql) => {
      control.queries++;
      if (!isList(sql)) return;
      control.listReads++;
      const hold = control.holdNext;
      control.holdNext = undefined;
      if (hold) {
        hold.entered.resolve();
        await hold.release.promise;
      }
      if (control.failNext) {
        control.failNext = false;
        read.resolve();
        throw new Error("D1_ERROR: Network connection lost.");
      }
    },
    (sql) => {
      if (isList(sql)) read.resolve();
    },
  );
  const OAUTH_KV = new Proxy(env.OAUTH_KV, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        control.kvOperations++;
        return Reflect.apply(value, target, args);
      };
    },
  });
  const baseline = read.promise;
  const reader = await mcp.listen(testEnv({ DB, OAUTH_KV }));
  onTestFinished(() => reader.cancel());
  const frames: unknown[] = [];
  let ended = false;
  const finished = (async () => {
    for (;;) {
      const frame = await reader.read();
      if (frame.done) break;
      frames.push(frame.value);
    }
    ended = true;
  })();
  await baseline;
  // Drain the Effect and SDK continuations after the real database promise settles.
  await vi.advanceTimersByTimeAsync(0);
  expect(frames).toEqual([acknowledged]);
  expect(ended).toBe(false);
  return { control, reader, frames, finished, ended: () => ended };
}
type Listening = Awaited<ReturnType<typeof listen>>;

async function tick(...streams: Listening[]) {
  const reads = streams.map((stream) => stream.control.nextRead());
  await vi.advanceTimersByTimeAsync(POLL_MS);
  await Promise.all(reads);
  await vi.advanceTimersByTimeAsync(0);
}
async function revoke(f: Awaited<ReturnType<typeof fixture>>) {
  const response = await f.mcp.browser.post(`/connections/${f.connection.id}/revoke`);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ outcome: "ok" });
}
async function expectComplete(stream: Listening, notices: number) {
  await stream.finished;
  expect(stream.frames).toEqual([
    acknowledged,
    ...Array.from({ length: notices }, () => changed),
    complete,
  ]);
  await stream.reader.cancel();
  expect(vi.getTimerCount()).toBe(0);
}

it.each(["allow", "remove"] as const)(
  "announces a list change after the owner chooses %s",
  async (action) => {
    const f = await fixture();
    if (action === "remove") await permission(f);
    const stream = await listen(f.mcp);
    if (action === "allow") await permission(f);
    else {
      const response = await f.mcp.browser.post(`/accounts/${f.personal.id}/remove`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ outcome: "ok" });
    }
    await tick(stream);
    expect(stream.frames).toEqual([acknowledged, changed]);
    await revoke(f);
    await tick(stream);
    await expectComplete(stream, 1);
  },
);

it("a changed permission announces only to that connection's stream", async () => {
  const f = await fixture();
  const other = await new McpClient().connect("Other laptop");
  const first = await listen(f.mcp);
  const second = await listen(other);
  await permission(f);
  await tick(first, second);
  expect(first.frames).toEqual([acknowledged, changed]);
  await tick(first, second);
  // Finish both at the lifetime to observe every frame, including the quiet connection's.
  for (let count = 2; count < TICKS; count++) await tick(first, second);
  await expectComplete(first, 1);
  await expectComplete(second, 0);
});

it("another account granting an already listed tool sends no notice", async () => {
  const f = await fixture();
  await permission(f);
  const stream = await listen(f.mcp);
  await permission(f, f.northwind);
  await tick(stream);
  await tick(stream);
  await revoke(f);
  await tick(stream);
  await expectComplete(stream, 0);
});

it("an earlier revision cannot open a GET stream", async () => {
  const mcp = await new McpClient().connect();
  const response = await callWorker(
    new Request(`${ORIGIN}/mcp`, {
      headers: {
        Authorization: `Bearer ${mcp.tokens!.access_token}`,
        Accept: "text/event-stream",
        "MCP-Protocol-Version": "2025-11-25",
      },
    }),
  );
  expect(response.status).toBe(405);
});

it.each(["revoked", "expired", "reset"] as const)(
  "completes within one tick when the connection is %s",
  async (ending) => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(NOW);
    const f = await fixture();
    await permission(f);
    const stream = await listen(f.mcp);
    if (ending === "revoked") await revoke(f);
    else if (ending === "expired") clock.mockReturnValue(f.connection.expires_at);
    else await resetOwner();
    await tick(stream);
    await expectComplete(stream, 0);
  },
);

it("stays open until tick 40, announces its final change before completion, and fits the request budget", async () => {
  expect(POLL_MS).toBe(5000);
  expect(TICKS).toBe(40);
  const f = await fixture();
  const stream = await listen(f.mcp);
  await tick(stream);
  await tick(stream);
  expect(stream.ended()).toBe(false);
  expect(stream.frames).toEqual([acknowledged]);
  for (let count = 2; count < 39; count++) await tick(stream);
  expect(stream.ended()).toBe(false);
  expect(stream.frames).toEqual([acknowledged]);
  await permission(f);
  await tick(stream);
  await expectComplete(stream, 1);
  expect(stream.control.listReads).toBe(41);
  expect(stream.control.queries).toBe(43);
  expect(stream.control.kvOperations).toBe(1);
  expect(stream.control.queries + stream.control.kvOperations).toBe(44);
});

it("a failed tick preserves the previous nonempty list and later announces one change", async () => {
  const f = await fixture();
  await permission(f);
  const stream = await listen(f.mcp);
  await permission(f, f.personal, false);
  stream.control.failNext = true;
  await tick(stream);
  expect(stream.ended()).toBe(false);
  expect(stream.frames).toEqual([acknowledged]);
  await tick(stream);
  expect(stream.frames).toEqual([acknowledged, changed]);
  await revoke(f);
  await tick(stream);
  await expectComplete(stream, 1);
});

it("repeated read failures still complete at the lifetime without notices", async () => {
  const f = await fixture();
  await permission(f);
  const stream = await listen(f.mcp);
  for (let count = 0; count < TICKS; count++) {
    stream.control.failNext = true;
    await tick(stream);
    if (count < TICKS - 1) expect(stream.ended()).toBe(false);
  }
  await expectComplete(stream, 0);
});

it("a failed baseline stays open and the first success becomes a silent baseline", async () => {
  const f = await fixture();
  const stream = await listen(f.mcp, true);
  await permission(f);
  await tick(stream);
  await tick(stream);
  expect(stream.ended()).toBe(false);
  expect(stream.frames).toEqual([acknowledged]);
  await permission(f, f.personal, false);
  await tick(stream);
  await revoke(f);
  await tick(stream);
  await expectComplete(stream, 1);
});

it.each([false, true])(
  "cancel stops all work, including an in-flight read: %s",
  async (inFlight) => {
    const f = await fixture();
    const stream = await listen(f.mcp);
    const hold = { entered: deferred(), release: deferred() };
    let read: Promise<void> | undefined;
    if (inFlight) {
      await permission(f);
      stream.control.holdNext = hold;
      read = stream.control.nextRead();
      await vi.advanceTimersByTimeAsync(POLL_MS);
      await hold.entered.promise;
    }
    await stream.reader.cancel();
    await stream.finished;
    expect(vi.getTimerCount()).toBe(0);
    const queries = stream.control.queries;
    hold.release.resolve();
    if (read) await read;
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(POLL_MS * TICKS);
    expect(stream.control.queries).toBe(queries);
    expect(stream.frames).toEqual([acknowledged]);
    expect(vi.getTimerCount()).toBe(0);
  },
);

import { Effect, Result } from "effect";
import { expect, it, vi } from "vite-plus/test";
import { changeEach, REQUESTS_AT_ONCE } from "../src/google/gmail";
import { notFound, ToolFailure } from "../src/mcp/failures";
import { deferred } from "./support/google";

it("finishes the first item alone and never opens more than five later requests at once", async () => {
  expect(REQUESTS_AT_ONCE).toBe(5);
  const ids = Array.from({ length: 12 }, (_, index) => `m${index}`);
  const entered = new Map(ids.map((id) => [id, deferred()]));
  const gates = new Map(ids.map((id) => [id, deferred()]));
  let open = 0;
  let most = 0;
  const one = vi.fn((id: string) =>
    Effect.promise(async () => {
      most = Math.max(most, ++open);
      entered.get(id)!.resolve();
      await gates.get(id)!.promise;
      open--;
      return id;
    }),
  );
  const pending = Effect.runPromise(changeEach("message", ids, one));
  try {
    await entered.get("m0")!.promise;
    expect(one.mock.calls).toEqual([["m0"]]);
    expect(open).toBe(1);
    gates.get("m0")!.resolve();
    await entered.get("m1")!.promise;
    expect(open).toBeLessThanOrEqual(5);
    for (const gate of gates.values()) gate.resolve();
    expect(await pending).toEqual({ changed: ids, not_found: [], unconfirmed: [] });
    expect(most).toBeLessThanOrEqual(5);
    expect(open).toBe(0);
  } finally {
    for (const gate of gates.values()) gate.resolve();
    await pending;
  }
});

it.each([
  {
    name: "five mixed answers",
    ids: ["a", "b", "c", "d", "e"],
    missing: ["b"],
    unconfirmed: ["d"],
    expected: {
      changed: [{ value: "A" }, { value: "C" }, { value: "E" }],
      not_found: ["b"],
      unconfirmed: ["d"],
    },
  },
  {
    name: "two IDs in each list",
    ids: ["a", "b", "c", "d", "e", "f"],
    missing: ["b", "e"],
    unconfirmed: ["d", "f"],
    expected: {
      changed: [{ value: "A" }, { value: "C" }],
      not_found: ["b", "e"],
      unconfirmed: ["d", "f"],
    },
  },
])(
  "keeps input order with $name finishing in reverse order",
  async ({ ids, missing, unconfirmed, expected }) => {
    const entered = new Map(ids.map((id) => [id, deferred()]));
    const gates = new Map(ids.map((id) => [id, deferred()]));
    const completed = new Map(ids.map((id) => [id, deferred()]));
    const finished: string[] = [];
    gates.get("a")!.resolve();
    const pending = Effect.runPromise(
      Effect.result(
        changeEach("message", ids, (id) =>
          Effect.gen(function* () {
            entered.get(id)!.resolve();
            yield* Effect.promise(() => gates.get(id)!.promise);
            finished.push(id);
            completed.get(id)!.resolve();
            if (missing.includes(id)) return yield* Effect.fail(notFound("message", id));
            if (unconfirmed.includes(id))
              return yield* Effect.fail(new ToolFailure({ code: "google_unavailable" }));
            return { value: id.toUpperCase() };
          }),
        ),
      ),
    );
    try {
      await Promise.all([...entered.values()].map((entry) => entry.promise));
      for (const id of ids.slice(1).toReversed()) {
        gates.get(id)!.resolve();
        await completed.get(id)!.promise;
      }
      expect(finished).toEqual(["a", ...ids.slice(1).toReversed()]);
      const result = await pending;
      expect(Result.isSuccess(result) && result.success).toEqual(expected);
    } finally {
      for (const gate of gates.values()) gate.resolve();
      await pending;
    }
  },
);

it("keeps successful empty responses and leaves empty classification lists as arrays", async () => {
  expect(await Effect.runPromise(changeEach("message", ["a", "b"], () => Effect.void))).toEqual({
    changed: [undefined, undefined],
    not_found: [],
    unconfirmed: [],
  });
});

it.each([{ ids: ["a"] }, { ids: ["a", "b", "c"] }])(
  "fails with all missing IDs $ids when no item exists",
  async ({ ids }) => {
    const one = vi.fn((id: string) => Effect.fail(notFound("message", id)));
    const result = await Effect.runPromise(Effect.result(changeEach("message", ids, one)));
    expect(Result.isFailure(result) && result.failure).toEqual(notFound("message", ids));
    expect(one.mock.calls.map(([id]) => id)).toEqual(ids);
  },
);

it.each([
  {
    name: "the first unavailable response",
    failures: [
      notFound("message", "a"),
      new ToolFailure({ code: "google_unavailable" }),
      new ToolFailure({ code: "google_unavailable" }),
    ],
    chosen: 1,
  },
  {
    name: "an unavailable response after a missing item",
    failures: [notFound("message", "a"), new ToolFailure({ code: "google_unavailable" })],
    chosen: 1,
  },
  {
    name: "the first unknown response over earlier confirmed failures",
    failures: [
      notFound("message", "a"),
      new ToolFailure({ code: "google_unavailable" }),
      new ToolFailure({ code: "google_unavailable", unknown: true }),
      new ToolFailure({ code: "google_unavailable", unknown: true }),
    ],
    chosen: 2,
  },
])(
  "selects $name in input order even when failures finish in reverse order",
  async ({ failures, chosen }) => {
    const ids = ["a", "b", "c", "d"].slice(0, failures.length);
    const entered = ids.map(() => deferred());
    const gates = ids.map(() => deferred());
    const completed = ids.map(() => deferred());
    gates[0]!.resolve();
    const pending = Effect.runPromise(
      Effect.result(
        changeEach("message", ids, (id) =>
          Effect.gen(function* () {
            const index = ids.indexOf(id);
            entered[index]!.resolve();
            yield* Effect.promise(() => gates[index]!.promise);
            completed[index]!.resolve();
            return yield* Effect.fail(failures[index]!);
          }),
        ),
      ),
    );
    try {
      await Promise.all(entered.map((entry) => entry.promise));
      for (let index = ids.length - 1; index > 0; index--) {
        gates[index]!.resolve();
        await completed[index]!.promise;
      }
      const result = await pending;
      expect(Result.isFailure(result) && result.failure).toBe(failures[chosen]);
    } finally {
      for (const gate of gates) gate.resolve();
      await pending;
    }
  },
);

it.each([
  new ToolFailure({ code: "account_needs_reconnect" }),
  new ToolFailure({ code: "google_unavailable" }),
  new ToolFailure({ code: "google_unavailable", unknown: true }),
])("stops after the first $code failure with unknown=$unknown", async (failure) => {
  const ids = Array.from({ length: 20 }, (_, index) => `m${index}`);
  const one = vi.fn(() => Effect.fail(failure));
  const result = await Effect.runPromise(Effect.result(changeEach("message", ids, one)));
  expect(Result.isFailure(result) && result.failure).toBe(failure);
  expect(one).toHaveBeenCalledExactlyOnceWith("m0");
});

it("continues after the first item is missing", async () => {
  const one = vi.fn((id: string) =>
    id === "a" ? Effect.fail(notFound("message", id)) : Effect.succeed(id),
  );
  expect(await Effect.runPromise(changeEach("message", ["a", "b", "c"], one))).toEqual({
    changed: ["b", "c"],
    not_found: ["a"],
    unconfirmed: [],
  });
  expect(one.mock.calls.map(([id]) => id)).toEqual(["a", "b", "c"]);
});

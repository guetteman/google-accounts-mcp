import { expect, it } from "vite-plus/test";
import { postAction } from "../src/pages/actions";
import { outcomeMessage } from "../src/pages/connection-actions";

it.each([
  ["already_ended", "Work laptop already ended. Nothing changed."],
  ["unavailable", "Couldn't reach the database. Nothing changed. Try again in a minute."],
  ["unknown", "Couldn't confirm the change. Reload the page to see whether it happened."],
] as const)("shows the exact dialog message for the %s JSON outcome", async (outcome, message) => {
  const send: typeof fetch = async () =>
    Response.json({ outcome }, { status: outcome === "already_ended" ? 200 : 503 });
  expect(
    outcomeMessage((await postAction("/connections/id/revoke", {}, send)).outcome, "Work laptop"),
  ).toBe(message);
});
it("tells the owner nothing changed when the gate returns a non-JSON 503", async () => {
  const send: typeof fetch = async () => new Response("Database unavailable", { status: 503 });
  expect(
    outcomeMessage(
      (await postAction("/connections/id/name", { name: "New name" }, send)).outcome,
      "Work laptop",
    ),
  ).toBe("Couldn't reach the database. Nothing changed. Try again in a minute.");
});
it.each(["rejected", "unreadable", "missing outcome"])(
  "cannot confirm a change after a %s answer",
  async (failure) => {
    const send: typeof fetch = async () => {
      if (failure === "rejected") throw new TypeError("Failed to fetch");
      return failure === "unreadable"
        ? new Response("{", { headers: { "Content-Type": "application/json" } })
        : Response.json({});
    };
    expect(
      outcomeMessage((await postAction("/connections/id/revoke", {}, send)).outcome, "Work laptop"),
    ).toBe("Couldn't confirm the change. Reload the page to see whether it happened.");
  },
);

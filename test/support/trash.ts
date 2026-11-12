import { expect } from "vite-plus/test";
import type { AccountRow } from "./accounts";
import { answer } from "./approvals";
import { google } from "./google";
import { fixture, permission, PERSONAL, toolCall } from "./permissions";
import { message } from "./thread";

export const operations = [
  {
    name: "trash_messages",
    method: "POST",
    suffix: "/trash",
    label: "Move to trash",
    permission: "Move messages to the trash. Gmail deletes a message for good after 30 days there.",
    action: "move messages to the trash",
    joiner: "in",
    destructive: true,
  },
  {
    name: "restore_messages",
    method: "POST",
    suffix: "/untrash",
    label: "Restore from trash",
    permission: "Take messages out of the trash.",
    action: "take messages out of the trash",
    joiner: "in",
    destructive: false,
  },
  {
    name: "delete_messages",
    method: "DELETE",
    suffix: "",
    label: "Delete permanently",
    permission: "Delete messages for good, without the trash. Nobody can recover them.",
    action: "delete messages permanently",
    joiner: "from",
    destructive: true,
  },
] as const;
export const WARNING =
  "These messages cannot be recovered. They do not go to the trash: Gmail deletes them at once and for good.";
export const ids15 = Array.from({ length: 15 }, (_, i) => `m${i + 1}`);
export const changed = (
  tool: string,
  ids: readonly string[],
  labels: string[] = tool === "trash_messages" ? ["UNREAD", "TRASH"] : ["UNREAD"],
) => (tool === "delete_messages" ? [...ids] : ids.map((message) => ({ message, labels })));
export const serveMessages = (ids: readonly string[]) => {
  for (const id of ids)
    google.trashAnswers.set(id, (request) =>
      request.method === "GET"
        ? Response.json(message(id))
        : request.method === "DELETE"
          ? new Response(null, { status: 204 })
          : Response.json({
              id,
              labelIds: new URL(request.url).pathname.endsWith("/untrash")
                ? ["UNREAD"]
                : ["UNREAD", "TRASH"],
            }),
    );
};
export const call = (
  f: Awaited<ReturnType<typeof fixture>>,
  tool: string,
  messages: unknown = ["m1", "m2"],
) => toolCall(f.mcp, tool, { account: PERSONAL, messages });
export const allowed = async (tool: string, overrides: Partial<AccountRow> = {}) => {
  const f = await fixture(overrides);
  await permission(f, f.personal, true, tool);
  return f;
};
export const asking = async (tool: string, messages: readonly string[] = ["m1", "m2"]) => {
  const f = await fixture();
  const response = await f.mcp.browser.post(`/connections/${f.connection.id}/permissions`, {
    account: f.personal.id,
    tool,
    setting: "ask",
  });
  expect(await response.json()).toEqual({ outcome: "ok" });
  const pending = await answer(await call(f, tool, messages));
  expect(pending.status).toBe("pending");
  return { ...f, id: pending.approval as string };
};

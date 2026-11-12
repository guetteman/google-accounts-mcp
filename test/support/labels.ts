import { expect } from "vite-plus/test";
import { HttpResponse } from "msw";
import type { AccountRow } from "./accounts";
import { answer } from "./approvals";
import { google } from "./google";
import { fixture, permission, PERSONAL, toolCall } from "./permissions";

export const FIRST = "19a1b2c3d4e5f601";
export const SECOND = "19a1b2c3d4e5f602";
export const MISSING = "19a1b2c3d4e5f6ff";
export const FOURTH = "19a1b2c3d4e5f6fe";
export const FIFTH = "19a1b2c3d4e5f603";
export const CHANGE = { threads: [FIRST], add: ["Label_12"], remove: ["INBOX"] };
export const SYSTEM_IDS = [
  "INBOX",
  "UNREAD",
  "STARRED",
  "IMPORTANT",
  "CATEGORY_PERSONAL",
  "CATEGORY_SOCIAL",
  "CATEGORY_PROMOTIONS",
  "CATEGORY_UPDATES",
  "CATEGORY_FORUMS",
];
export const LABELS = [
  ...SYSTEM_IDS.map((id) => ({ id, name: id, type: "system" as const })),
  { id: "Label_12", name: "Receipts", type: "user" as const },
];
export const labels = (items = LABELS, reads = 1) => {
  for (let i = 0; i < reads; i++)
    google.labelAnswers.push(() => HttpResponse.json({ labels: items }));
};
export const fieldMessage = (field: string) =>
  `The ${field} field must be a list of at most 100 label IDs that list_labels returned. Of the system labels, only INBOX, UNREAD, STARRED, IMPORTANT, and the five CATEGORY_ labels are accepted. A label cannot be in both add and remove, and the two lists together need at least one label.`;
export const setting = async (
  f: Awaited<ReturnType<typeof fixture>>,
  value: "ask" | "allow" | "deny",
) => {
  const response = await f.mcp.browser.post(`/connections/${f.connection.id}/permissions`, {
    account: f.personal.id,
    tool: "change_labels",
    setting: value,
  });
  expect(await response.json()).toEqual({ outcome: "ok" });
};
export const labelCall = (
  f: Awaited<ReturnType<typeof fixture>>,
  args: Record<string, unknown> = CHANGE,
) => toolCall(f.mcp, "change_labels", { account: PERSONAL, ...args });
export const allowed = async (overrides: Partial<AccountRow> = {}) => {
  const f = await fixture(overrides);
  await permission(f, f.personal, true, "change_labels");
  return f;
};
export const asking = async (args: Record<string, unknown> = CHANGE) => {
  const f = await fixture();
  await setting(f, "ask");
  const pending = await answer(await labelCall(f, args));
  expect(pending.status).toBe("pending");
  return { ...f, id: pending.approval as string };
};
export const mixed = () => {
  google.modifyAnswers.set(FOURTH, () => new HttpResponse(null, { status: 503 }));
  google.modifyAnswers.set(FIFTH, () =>
    HttpResponse.json({
      id: FIFTH,
      messages: [{ id: "m5", threadId: FIFTH, labelIds: ["STARRED"] }],
    }),
  );
  return [FIRST, MISSING, SECOND, FOURTH, FIFTH];
};

export const DESCRIPTION =
  "Adds and removes labels on threads of one Google account. `account` is the address of an account that list_accounts returns. `threads` is a list of 1 to 15 thread IDs that search_threads returned for that account. `add` and `remove` are lists of label IDs that list_labels returned for that account, at most 100 each; the call needs at least one label, and no label in both lists. The change applies to every message of each thread. To archive a thread, remove `INBOX`; to move it back to the inbox, for example after a message came out of the trash, add `INBOX`. To mark it as read, remove `UNREAD`; to mark it as unread, add `UNREAD`. To star it, add `STARRED`. Of the system labels, the tool accepts only `INBOX`, `UNREAD`, `STARRED`, `IMPORTANT`, and the five `CATEGORY_` labels: it does not move mail to the trash or to spam, and it creates no label. The result's `threads` has one entry for each thread that changed: its ID and `labels`, the IDs of the labels that at least one of its messages has after the change. `not_found` lists the threads that the account does not have. `unconfirmed` lists the threads whose change Google did not confirm: send the call again with those threads, because repeating a change is safe. Each of the two is left out when it is empty. The call fails as a whole only when no thread changed. When the owner sets this tool to ask, it returns a pending approval with a link instead of a result; get_approval returns the result after the owner approves.";

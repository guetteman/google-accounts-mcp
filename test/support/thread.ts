import { HttpResponse } from "msw";
import type { RawMessage } from "../../src/google/message";
import { google } from "./google";
import { answer } from "./approvals";
import { fixture, permission, PERSONAL, toolCall } from "./permissions";

export const THREAD = "19a1b2c3d4e5f601";
export const bytes = (text: string) =>
  btoa(Array.from(new TextEncoder().encode(text), (c) => String.fromCharCode(c)).join(""))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
export const part = (mimeType: string, text = "", partId = "", filename = "") => ({
  partId,
  mimeType,
  filename,
  headers: [] as Array<{ name: string; value: string }>,
  body: { size: new TextEncoder().encode(text).length, data: bytes(text) } as {
    size: number;
    data?: string;
    attachmentId?: string;
  },
});
export const tree = (mimeType: string, parts: RawMessage["payload"]["parts"]) => ({
  ...part(mimeType),
  parts,
});
export const message = (id = "m1", text = "Hello"): RawMessage => ({
  id,
  internalDate: "1794390096000",
  labelIds: ["INBOX", "UNREAD"],
  payload: {
    ...part("text/plain", text),
    headers: [
      { name: "Subject", value: "Lunch" },
      { name: "From", value: "Sam <sam@example.com>" },
      { name: "To", value: PERSONAL },
    ],
  },
});
export const serveThread = (messages: readonly RawMessage[]) =>
  google.threadAnswers.set(THREAD, () =>
    HttpResponse.json({ id: THREAD, historyId: "12345678", messages }),
  );
export const read = (f: Awaited<ReturnType<typeof fixture>>, args: Record<string, unknown> = {}) =>
  toolCall(f.mcp, "read_thread", { account: PERSONAL, thread: THREAD, ...args });
export const allowed = async (expired = false) => {
  const f = await fixture(expired ? { access_expires_at: Date.now() - 1000 } : {});
  await permission(f, f.personal, true, "read_thread");
  return f;
};
export const asking = async (args: Record<string, unknown> = {}) => {
  const f = await fixture();
  await f.mcp.browser.post(`/connections/${f.connection.id}/permissions`, {
    account: f.personal.id,
    tool: "read_thread",
    setting: "ask",
  });
  const pending = await answer(await read(f, args));
  return { ...f, id: pending.approval as string };
};

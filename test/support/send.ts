import type { RawPart } from "../../src/google/message";
import { expect } from "vite-plus/test";
import { fixture, PERSONAL, toolCall } from "./permissions";
import { google, deferred } from "./google";
import { sourceHeaders, SOURCE, THREAD } from "./draft";
import { message } from "./thread";

export const sendCases = [
  {
    name: "send_message",
    args: { to: ["Sam <sam@example.com>"], subject: "Lunch", body: "Hello" },
  },
  { name: "send_reply", args: { message: SOURCE, body: "Hello" } },
  { name: "forward_message", args: { message: SOURCE, to: ["lee@example.com"] } },
  { name: "send_draft", args: { draft: "existing-draft" } },
] as const;
export type SendName = (typeof sendCases)[number]["name"];
export type SendFixture = Awaited<ReturnType<typeof fixture>>;
export const setSend = async (
  f: SendFixture,
  name: SendName,
  setting: "allow" | "ask" | "deny",
) => {
  const response = await f.mcp.browser.post(`/connections/${f.connection.id}/permissions`, {
    account: f.personal.id,
    tool: name,
    setting,
  });
  expect(await response.json()).toEqual({ outcome: "ok" });
};
export type FullMessage = {
  id: string;
  threadId: string;
  internalDate: string;
  labelIds?: readonly string[];
  payload: {
    partId: string;
    mimeType: string;
    filename: string;
    headers: Array<{ name: string; value: string }>;
    body: { size: number; data?: string; attachmentId?: string };
    parts?: readonly RawPart[];
  };
};
export const fullMessage = (headers: Record<string, string> = {}): FullMessage => ({
  ...message(SOURCE, "Lunch on Friday?"),
  threadId: THREAD,
  payload: {
    ...message().payload,
    body: message(SOURCE, "Lunch on Friday?").payload.body,
    headers: Object.entries({ ...sourceHeaders, ...headers }).map(([name, value]) => ({
      name,
      value,
    })),
  },
});
export const serveFull = (raw = fullMessage()) => {
  google.messageAnswers.set(SOURCE, () => Response.json(raw));
};
export const sendFixture = async (
  name: SendName = "send_message",
  setting: "allow" | "ask" = "allow",
) => {
  const f = await fixture();
  await setSend(f, name, setting);
  serveFull();
  google.storedDrafts.set("existing-draft", fullMessage({ From: `Alex <${PERSONAL}>` }));
  return f;
};
export const sendCall = (
  f: SendFixture,
  name: SendName = "send_message",
  args: Record<string, unknown> = {},
  workerEnv?: Env,
) =>
  toolCall(
    f.mcp,
    name,
    { account: PERSONAL, ...sendCases.find((c) => c.name === name)!.args, ...args },
    workerEnv,
  );
export const hold = (
  queue: Array<(request: Pick<Request, "signal">) => Response | Promise<Response>>,
  response: Response,
) => {
  const entered = deferred();
  const released = deferred();
  queue.push(async () => {
    entered.resolve();
    await released.promise;
    return response;
  });
  return { entered: entered.promise, release: released.resolve };
};
export const created = () =>
  Response.json({ id: "draft-1", message: { id: "message-1", threadId: "thread-1" } });
export const sent = () => Response.json({ id: "sent-1", threadId: "thread-1" });
export const never = (request: Pick<Request, "signal">) =>
  new Promise<Response>((_resolve, reject) => {
    if (request.signal.aborted) reject(request.signal.reason);
    else
      request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
  });
export interface Mime {
  headers: Record<string, string>;
  entries: ReadonlyArray<readonly [string, string]>;
  parts: Mime[];
  data: Uint8Array;
}
export const mime = (text: string): Mime => {
  const at = text.indexOf("\r\n\r\n");
  const envelope = text.slice(0, at);
  const entries = envelope
    .replace(/\r\n[ \t]/g, " ")
    .split("\r\n")
    .map((line) => {
      const split = line.indexOf(":");
      return [line.slice(0, split), line.slice(split + 1).trim()] as const;
    });
  const headers = Object.fromEntries(entries);
  const boundary = /boundary="?([^";]+)/.exec(headers["Content-Type"] ?? "")?.[1];
  const parts = boundary
    ? text
        .slice(at + 4)
        .split(`--${boundary}`)
        .slice(1, -1)
        .map((part) => mime(part.replace(/^\r\n/, "").replace(/\r\n$/, "")))
    : [];
  const data = boundary
    ? new Uint8Array()
    : Uint8Array.from(atob(text.slice(at + 4).replace(/\s/g, "")), (c) => c.charCodeAt(0));
  return { headers, entries, parts, data };
};

export const leftoverMessage = `Nothing was sent from ${PERSONAL}. Google did not confirm a step before the send, so a draft of this mail may be left in Drafts. The owner should delete it there before this call is made again.`;
export const leftoverDraftMessage = `Nothing was sent from ${PERSONAL}. Google did not confirm a step before the send, so draft "draft-1" of this mail may be left in Drafts. The owner should delete it there before this call is made again.`;
export const leftoverNote =
  ' Draft "draft-1" of this mail may be left in Drafts. The owner should delete it there before this call is made again.';

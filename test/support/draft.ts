import { env } from "cloudflare:workers";
import { expect } from "vite-plus/test";
import { google } from "./google";
import { fixture, PERSONAL, toolCall } from "./permissions";

export const SOURCE = "answered-message";
export const THREAD = "answered-thread";
export const sourceHeaders = {
  From: "Sam <sam@example.com>",
  To: `Alex <${PERSONAL}>, Kim <kim@example.com>`,
  Cc: "Jo <jo@example.com>, sam@EXAMPLE.com, ALEX.PERSONAL@EXAMPLE.COM",
  Subject: "Lunch",
  "Message-ID": "<source@example.com>",
  References: "<earlier@example.com>",
};
export const serveMessage = (headers: Record<string, string | undefined> = {}) =>
  google.messageAnswers.set(SOURCE, () =>
    Response.json({
      id: SOURCE,
      threadId: THREAD,
      internalDate: "1794390096000",
      payload: {
        headers: Object.entries({ ...sourceHeaders, ...headers })
          .filter((entry) => entry[1] !== undefined)
          .map(([name, value]) => ({
            name,
            value,
          })),
      },
    }),
  );
export const setDraft = async (
  f: Awaited<ReturnType<typeof fixture>>,
  setting: "allow" | "ask" | "deny",
) => {
  const response = await f.mcp.browser.post(`/connections/${f.connection.id}/permissions`, {
    account: f.personal.id,
    tool: "create_draft",
    setting,
  });
  expect(await response.json()).toEqual({ outcome: "ok" });
};
export const draftFixture = async (setting: "allow" | "ask" = "allow") => {
  const f = await fixture();
  await setDraft(f, setting);
  return f;
};
export const draftCall = (
  f: Awaited<ReturnType<typeof fixture>>,
  args: Record<string, unknown> = {},
  workerEnv?: Env,
) => toolCall(f.mcp, "create_draft", { account: PERSONAL, body: "Hello", ...args }, workerEnv);
const utf8 = (binary: string) =>
  new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
export const decodeWords = (value: string) =>
  value
    .replace(/(\?=)\s+(=\?)/g, "$1$2")
    .replace(/=\?UTF-8\?B\?([^?]*)\?=/gi, (_, encoded: string) => utf8(atob(encoded)));
export const decodedMail = (index = google.draftCreates.length - 1) => {
  const body = google.draftCreates[index]!.body as { message: { raw: string; threadId?: string } };
  const text = utf8(atob(body.message.raw.replaceAll("-", "+").replaceAll("_", "/")));
  const [envelope, ...part] = text.split("\r\n\r\n");
  const entries = envelope!
    .replace(/\r\n[ \t]/g, " ")
    .split("\r\n")
    .map((line) => {
      const split = line.indexOf(":");
      return [line.slice(0, split), decodeWords(line.slice(split + 1).trim())] as const;
    });
  return {
    text,
    entries,
    headers: Object.fromEntries(entries),
    body: utf8(atob(part.join("\r\n\r\n").replace(/\s/g, ""))),
    request: body,
  };
};
export const onceRows = async () =>
  (
    await env.DB.prepare("SELECT * FROM once ORDER BY rowid").all<{
      identity: string;
      state: string;
      taken_at: number;
      expires_at: number;
    }>()
  ).results;
export const replyCases = [
  {
    name: "Reply-To the account itself",
    headers: { "Reply-To": PERSONAL.toUpperCase() },
    args: {},
    to: PERSONAL.toUpperCase(),
    cc: undefined,
  },
  {
    name: "Reply-To",
    headers: { "Reply-To": "Replies <reply@example.com>" },
    args: {},
    to: "Replies <reply@example.com>",
    cc: undefined,
  },
  { name: "From", headers: {}, args: {}, to: "Sam <sam@example.com>", cc: undefined },
  {
    name: "reply all",
    headers: {},
    args: { reply_all: true },
    to: "Sam <sam@example.com>",
    cc: "Kim <kim@example.com>, Jo <jo@example.com>",
  },
  {
    name: "self sent",
    headers: {
      From: `Alex <${PERSONAL.toUpperCase()}>`,
      To: "Kim <kim@example.com>",
      Cc: "Jo <jo@example.com>",
    },
    args: {},
    to: "Kim <kim@example.com>",
    cc: undefined,
  },
  {
    name: "self sent reply all",
    headers: {
      From: PERSONAL.toUpperCase(),
      To: "Kim <kim@example.com>",
      Cc: "Jo <jo@example.com>",
    },
    args: { reply_all: true },
    to: "Kim <kim@example.com>",
    cc: "Jo <jo@example.com>",
  },
  {
    name: "given To",
    headers: {},
    args: { to: ["New <new@example.com>"] },
    to: "New <new@example.com>",
    cc: undefined,
  },
  {
    name: "given Cc",
    headers: {},
    args: { cc: ["New <new@example.com>"] },
    to: undefined,
    cc: "New <new@example.com>",
  },
  {
    name: "given Bcc",
    headers: {},
    args: { bcc: ["New <new@example.com>"] },
    to: undefined,
    cc: undefined,
    bcc: "New <new@example.com>",
  },
] as const;

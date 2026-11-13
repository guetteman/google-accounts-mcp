import { expect } from "vite-plus/test";
import { env } from "cloudflare:workers";
import { fixture, toolCall, PERSONAL, NORTHWIND } from "./permissions";
import { answer } from "./approvals";
import { callWorker, testEnv } from "./worker";
import type { AccountRow } from "./accounts";
import { filePart, serveAttachment, MESSAGE } from "./attachment";
import { mime, type Mime } from "./send";
import { google } from "./google";
import { decodeWords } from "./draft";

export type AttachName = "create_draft" | "send_message" | "send_reply";
export const input = {
  to: ["Sam <sam@example.com>"],
  cc: ["jo@example.com"],
  bcc: ["lee@example.com"],
  subject: "Files for lunch",
  body: "Hi ñ\n\nHere are the files.\n",
};
export const copy = { account: NORTHWIND, message: MESSAGE, attachment: "2" };
export const setTool = async (
  f: Awaited<ReturnType<typeof fixture>>,
  tool: string,
  setting: "ask" | "allow" | "deny",
  account: AccountRow = f.personal,
) => {
  expect(
    await (
      await f.mcp.browser.post(`/connections/${f.connection.id}/permissions`, {
        account: account.id,
        tool,
        setting,
      })
    ).json(),
  ).toEqual({ outcome: "ok" });
};
export const attaching = async (
  name: AttachName = "send_message",
  setting: "ask" | "allow" = "allow",
) => {
  const f = await fixture();
  await setTool(f, name, setting);
  serveAttachment();
  return f;
};
export type AttachFixture = Awaited<ReturnType<typeof attaching>>;
export const link = (f: AttachFixture, workerEnv?: Env) =>
  toolCall(f.mcp, "create_upload_link", undefined, workerEnv).then(answer) as Promise<{
    url: string;
    expires_at: string;
  }>;
export const put = (
  url: string,
  bytes: BodyInit | null = "FILE",
  type?: string,
  workerEnv = testEnv(),
) =>
  callWorker(
    new Request(url, {
      method: "PUT",
      body: bytes,
      ...(type ? { headers: { "Content-Type": type } } : {}),
    }),
    workerEnv,
  );
export const upload = async (
  f: AttachFixture,
  bytes = new Uint8Array([0, 255, 10, 65]),
  filename = "local.pdf",
  type = "application/pdf",
) => {
  const made = await link(f);
  const response = await put(made.url + encodeURIComponent(filename), bytes, type);
  expect(response.status).toBe(201);
  return response.json<{
    upload: string;
    filename: string;
    type: string;
    size: number;
    expires_at: string;
  }>();
};
export const attachCall = (
  f: AttachFixture,
  attachments: unknown,
  args: Record<string, unknown> = {},
  name: AttachName = "send_message",
  workerEnv?: Env,
) =>
  toolCall(
    f.mcp,
    name,
    {
      account: PERSONAL,
      ...(name === "send_reply" ? { message: "source", body: input.body } : input),
      attachments,
      ...args,
    },
    workerEnv,
  );
export const uploads = async () =>
  (
    await env.DB.prepare("SELECT * FROM uploads ORDER BY rowid").all<{
      id: string;
      link: string;
      file: string | null;
      expires_at: number;
      connection_id: string;
    }>()
  ).results;
export const noWrites = () => {
  expect(google.uploads).toEqual([]);
  expect(google.draftCreates).toEqual([]);
  expect(google.sends).toEqual([]);
};
export const fileOf = (part: Mime) => ({
  filename: decodeURIComponent(part.headers["Content-Disposition"]!.split("UTF-8''")[1]!),
  type: part.headers["Content-Type"],
  bytes: part.data,
});
/** Compare the whole outgoing envelope and every MIME leaf with independent arguments. */
export const expectMail = (expected: {
  headers?: Record<string, string | undefined>;
  text?: string;
  files: Array<{ filename: string; type: string; bytes: Uint8Array }>;
}) => {
  const mail = mime(google.uploads.at(-1)!.message);
  const headers = {
    To: input.to.join(", "),
    Cc: input.cc.join(", "),
    Bcc: input.bcc.join(", "),
    Subject: input.subject,
    ...expected.headers,
  };
  const actual = Object.fromEntries(
    mail.entries
      .filter(([name]) => !["MIME-Version", "Content-Type"].includes(name))
      .map(([name, value]) => [name, decodeWords(value)]),
  );
  expect(actual).toEqual(
    Object.fromEntries(Object.entries(headers).filter(([, value]) => value !== undefined)),
  );
  expect(mail.entries).toHaveLength(
    Object.values(headers).filter((value) => value !== undefined).length + 2,
  );
  expect(mail.headers["MIME-Version"]).toBe("1.0");
  expect(mail.headers["Content-Type"]).toMatch(/^multipart\/mixed; boundary="mixed-/);
  expect(mail.parts).toHaveLength(1 + expected.files.length);
  expect(mail.parts[0]!.headers).toEqual({
    "Content-Type": "text/plain; charset=UTF-8",
    "Content-Transfer-Encoding": "base64",
  });
  expect(new TextDecoder().decode(mail.parts[0]!.data)).toBe(expected.text ?? input.body);
  for (const [i, file] of expected.files.entries()) {
    const leaf = mail.parts[i + 1]!;
    expect(leaf.parts).toEqual([]);
    expect(Object.keys(leaf.headers)).toEqual([
      "Content-Type",
      "Content-Disposition",
      "Content-Transfer-Encoding",
    ]);
    expect(fileOf(leaf)).toEqual(file);
  }
  return mail;
};
export { filePart, serveAttachment };

/** Observe real KV reads; optionally make a read look temporarily unavailable. */
export const watchedFiles = (misses = 0) => {
  const reads: string[] = [];
  const files = new Proxy(env.FILES_KV, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key);
      if (key === "get")
        return (...args: unknown[]) => {
          reads.push(String(args[0]));
          if (misses-- > 0) return Promise.resolve(null);
          return Reflect.apply(value as (...args: unknown[]) => unknown, target, args);
        };
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { files, reads };
};

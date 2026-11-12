import { Buffer } from "node:buffer";
import { expect } from "vite-plus/test";
import type { CallToolResult } from "@modelcontextprotocol/server";
import type { RawMessage, RawPart } from "../../src/google/message";
import { google } from "./google";
import { rpcResult } from "./oauth";
import { fixture, permission, PERSONAL } from "./permissions";
import { answer } from "./approvals";
import { message, part, tree } from "./thread";

export const MESSAGE = "m-file";
export const CONTENT = new Uint8Array([0, 255, 254, 1, 128, 13, 10, 65]);
export const filePart = (
  type = "application/pdf",
  filename = "menu.pdf",
  bytes = CONTENT,
): RawPart => ({
  ...part(type, "", "2", filename),
  body: { size: bytes.length, data: Buffer.from(bytes).toString("base64url") },
});
export const serveAttachment = (file: RawPart = filePart()): RawMessage => {
  const raw = message(MESSAGE);
  const full = {
    ...raw,
    payload: {
      ...tree("multipart/mixed", [part("text/plain", "Body", "1"), file]),
      headers: raw.payload.headers,
    },
  };
  google.messageAnswers.set(MESSAGE, () => Response.json(full));
  return full;
};
export const allowedAttachment = async () => {
  const f = await fixture();
  await permission(f, f.personal, true, "get_attachment");
  return f;
};
export const download = (
  f: Awaited<ReturnType<typeof fixture>>,
  args: Record<string, unknown> = {},
  client: string | null = "claude-code",
  workerEnv?: Env,
) => {
  const input = { account: PERSONAL, message: MESSAGE, attachment: "2", ...args };
  return f.mcp.namedCall("get_attachment", input, client, workerEnv);
};
export const blocks = async (response: Response): Promise<CallToolResult> =>
  (await rpcResult(response)) as unknown as CallToolResult;
export const metadata = (out: CallToolResult): Record<string, unknown> => {
  expect(out.content[0]?.type).toBe("text");
  return JSON.parse((out.content[0] as { text: string }).text) as Record<string, unknown>;
};
export const resourceBytes = (out: CallToolResult) => {
  expect(out.isError).toBeUndefined();
  expect(out.content).toHaveLength(2);
  const block = out.content[1];
  expect(block?.type).toBe("resource");
  if (block?.type !== "resource" || !("blob" in block.resource))
    throw new Error("Expected file resource");
  return new Uint8Array(Buffer.from(block.resource.blob, "base64"));
};
export const fileError = async (response: Response, code: string, message: string | RegExp) => {
  const out = await blocks(response);
  expect(out.isError).toBe(true);
  expect(out.content).toHaveLength(1);
  expect(metadata(out)).toEqual({
    code,
    message: typeof message === "string" ? message : expect.stringMatching(message),
  });
};
export const askingAttachment = async (file = filePart()) => {
  const f = await fixture();
  serveAttachment(file);
  expect(
    await (
      await f.mcp.browser.post(`/connections/${f.connection.id}/permissions`, {
        account: f.personal.id,
        tool: "get_attachment",
        setting: "ask",
      })
    ).json(),
  ).toEqual({ outcome: "ok" });
  const pending = await answer(await download(f, {}, null));
  expect(pending.status).toBe("pending");
  return { ...f, id: pending.approval as string };
};

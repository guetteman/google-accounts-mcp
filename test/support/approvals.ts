import { env } from "cloudflare:workers";
import { expect } from "vite-plus/test";
import type { ApprovalPageProps, ApprovalRow } from "../../src/approvals/model";
import { fixture, toolCall, PERSONAL } from "./permissions";
import { rpcResult } from "./oauth";
import { testEnv } from "./worker";
export type Fixture = Awaited<ReturnType<typeof fixture>>;
export const setting = async (
  f: Fixture,
  value: "ask" | "allow" | "deny",
  account = f.personal,
) => {
  const response = await f.mcp.browser.post(`/connections/${f.connection.id}/permissions`, {
    account: account.id,
    tool: "list_labels",
    setting: value,
  });
  expect(await response.json()).toEqual({ outcome: "ok" });
};
export async function answer(response: Response): Promise<Record<string, unknown>> {
  const result = await rpcResult(response);
  expect(result.isError).toBeUndefined();
  return JSON.parse((result.content as { text: string }[])[0]!.text) as Record<string, unknown>;
}
export async function ask(
  f: Fixture,
  args: Record<string, unknown> = { account: PERSONAL },
  workerEnv = testEnv(),
) {
  const result = await answer(await toolCall(f.mcp, "list_labels", args, workerEnv));
  expect(result.status).toBe("pending");
  return result.approval as string;
}
export const row = (id: string) =>
  env.DB.prepare("SELECT * FROM approvals WHERE id = ?").bind(id).first<ApprovalRow>();
export const rows = async () =>
  (await env.DB.prepare("SELECT * FROM approvals ORDER BY rowid").all<ApprovalRow>()).results;
export const props = async (response: Response) => {
  expect(response.status).toBe(200);
  return JSON.parse(
    /<script id="page-props" type="application\/json">([\s\S]*?)<\/script>/.exec(
      await response.text(),
    )![1]!,
  ) as ApprovalPageProps;
};
export const page = (f: Fixture, id: string, workerEnv = testEnv()) =>
  f.mcp.browser.get(`/approvals/${id}`, { env: workerEnv }).then(props);
export const digest = async (f: Fixture, id: string) => {
  const value = (await page(f, id)).state;
  expect(value.kind).toBe("waiting");
  return value.kind === "waiting" ? value.digest! : "";
};
export const post = (
  f: Fixture,
  id: string,
  action: "approve" | "reject",
  form: Record<string, string> = {},
  workerEnv = testEnv(),
) => f.mcp.browser.post(`/approvals/${id}/${action}`, form, { env: workerEnv });
export const decided = async (response: Response) => {
  expect(response.status).toBe(200);
  return ((await response.json()) as { approval: ApprovalPageProps }).approval;
};
export const approve = async (f: Fixture, id: string, workerEnv = testEnv()) =>
  post(f, id, "approve", { digest: await digest(f, id) }, workerEnv).then(decided);
export const get = (f: Fixture, id: string, workerEnv = testEnv()) =>
  toolCall(f.mcp, "get_approval", { approval: id }, workerEnv).then(answer);

export async function winningClaim(id: string) {
  const stored = await env.DB.prepare("SELECT id, claim, decided_at FROM approvals WHERE id = ?")
    .bind(id)
    .first<{ id: ApprovalRow["id"]; claim: string; decided_at: number }>();
  expect(stored?.claim).toEqual(expect.any(String));
  return { id: stored!.id, claim: stored!.claim, at: stored!.decided_at };
}

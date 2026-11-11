import { env } from "cloudflare:workers";
import { expect, vi } from "vite-plus/test";
import type { ApprovalPageProps, ApprovalId, Won } from "../../src/approvals/model";
import { Effect } from "effect";
import * as store from "../../src/approvals/store";
import type { ConnectionId } from "../../src/connections/model";
import type { Sealed } from "../../src/seal";
import { fixture, toolCall, PERSONAL } from "./permissions";
import { rpcResult } from "./oauth";
import { testEnv } from "./worker";
interface ApprovalRow {
  id: ApprovalId;
  connection_id: ConnectionId;
  call_id: number;
  created_at: number;
  expires_at: number;
  state: "waiting" | "approved" | "rejected" | "expired" | "refused";
  ended_by: "tool" | "connection" | "account" | null;
  decided_at: number | null;
  outcome: "success" | "failed" | "unknown" | null;
  arguments: Sealed | null;
  result: Sealed | null;
  uses: string;
}
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

/** Observe the store's actual return value; never manufacture a winning claim from SQL. */
export function observeDecisions() {
  const wins = new Map<string, Won>();
  const original = store.decideApproval;
  vi.spyOn(store, "decideApproval").mockImplementation((ctx, input) =>
    original(ctx, input).pipe(
      Effect.tap((decision) =>
        Effect.sync(() => {
          if (decision.won) wins.set(decision.won.id, decision.won);
        }),
      ),
    ),
  );
  return async (id: string): Promise<Won> => {
    const won = wins.get(id);
    if (!won) throw new Error("The decision did not return a Won");
    const stored = await env.DB.prepare("SELECT claim FROM approvals WHERE id = ?")
      .bind(id)
      .first<{ claim: string }>();
    expect(stored?.claim).toEqual(expect.any(String));
    return won;
  };
}

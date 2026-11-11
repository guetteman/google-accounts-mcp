import { env } from "cloudflare:workers";
import { expect, it, vi } from "vite-plus/test";
import "./support/account-checks";
import { NOW } from "./support/accounts";
import { Browser } from "./support/browser";
import { google, LABELS_RESPONSE, LABELS_URL } from "./support/google";
import { McpClient, rpcResult } from "./support/oauth";
import {
  callRows,
  expectError,
  fixture,
  googleTraffic,
  PERSONAL,
  toolCall,
} from "./support/permissions";
import { ORIGIN } from "./support/worker";

// Approval flow through the Worker's public interfaces only: the owner's
// page actions, the MCP endpoint, and the approval page with its two actions.
type Fixture = Awaited<ReturnType<typeof fixture>>;
const HOUR = 60 * 60 * 1000;
const labels = LABELS_RESPONSE.labels.map(({ id, name, type }) => ({ id, name, type }));
const PENDING_MESSAGE =
  "The owner must approve this call before it runs. Give the owner this link in your reply and end your turn. After the owner tells you that they decided, call get_approval with this approval ID.";

async function setting(f: Fixture, value: "deny" | "ask" | "allow", account = f.personal) {
  const response = await f.mcp.browser.post(`/connections/${f.connection.id}/permissions`, {
    account: account.id,
    tool: "list_labels",
    setting: value,
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ outcome: "ok" });
}
async function answer(response: Response): Promise<Record<string, unknown>> {
  const result = await rpcResult(response);
  expect(result.isError, "an answer about an approval is not an error result").toBeUndefined();
  const content = result.content as Array<{ type: string; text: string }>;
  expect(content).toHaveLength(1);
  return JSON.parse(content[0]!.text) as Record<string, unknown>;
}
async function ask(f: Fixture) {
  const pending = await answer(await toolCall(f.mcp, "list_labels", { account: PERSONAL }));
  expect(pending.status).toBe("pending");
  return pending as { approval: string; url: string; expires_at: string; message: string };
}
const getApproval = (mcp: McpClient, approval: unknown) =>
  toolCall(mcp, "get_approval", { approval });
interface ApprovalProps {
  _tag: "Approval";
  state: { kind: string; digest?: string | null; changed?: boolean; by?: string };
}
async function pageProps(response: Response): Promise<ApprovalProps> {
  expect(response.status).toBe(200);
  const match = /<script id="page-props" type="application\/json">([\s\S]*?)<\/script>/.exec(
    await response.text(),
  );
  expect(match, "the approval page is hydrated from its props").not.toBeNull();
  return JSON.parse(match![1]!) as ApprovalProps;
}
async function decide(
  browser: Browser,
  id: string,
  action: "approve" | "reject",
  form: Record<string, string> = {},
) {
  const response = await browser.post(`/approvals/${id}/${action}`, form);
  expect(response.status).toBe(200);
  return ((await response.json()) as { approval: ApprovalProps }).approval;
}
const approvalRow = (id: string) =>
  env.DB.prepare("SELECT * FROM approvals WHERE id = ?").bind(id).first<Record<string, unknown>>();
const listLabelsRecord = async () => (await callRows()).find((row) => row.tool === "list_labels")!;

it("answers pending with a link, contacts no Google host, and records pending", async () => {
  const f = await fixture();
  await setting(f, "ask");
  const before = googleTraffic().length;
  const pending = await ask(f);
  expect(pending.approval).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  expect(pending).toEqual({
    status: "pending",
    approval: pending.approval,
    url: `${ORIGIN}/approvals/${pending.approval}`,
    expires_at: "2030-11-09T13:00:00Z",
    message: PENDING_MESSAGE,
  });
  expect(googleTraffic().slice(before)).toEqual([]);
  expect((await listLabelsRecord()).outcome).toBe("pending");
  const row = await approvalRow(pending.approval);
  expect(row).toMatchObject({ state: "waiting", expires_at: NOW + HOUR, result: null });
  expect(String(row!.arguments)).not.toContain(PERSONAL);
});

it("runs the call once when the owner approves, and get_approval returns its result", async () => {
  const f = await fixture();
  await setting(f, "ask");
  const { approval } = await ask(f);
  const page = await pageProps(await f.mcp.browser.get(`/approvals/${approval}`));
  expect(page._tag).toBe("Approval");
  expect(page.state).toMatchObject({ kind: "waiting", changed: false });
  expect(await answer(await getApproval(f.mcp, approval))).toMatchObject({
    status: "pending",
    url: `${ORIGIN}/approvals/${approval}`,
    expires_at: "2030-11-09T13:00:00Z",
  });
  google.labelRequests.length = 0;
  const digest = String(page.state.digest);
  expect((await decide(f.mcp.browser, approval, "approve", { digest })).state.kind).toBe(
    "succeeded",
  );
  // A second Approve, as from a second device, shows the same state and runs nothing.
  expect((await decide(f.mcp.browser, approval, "approve", { digest })).state.kind).toBe(
    "succeeded",
  );
  expect((await decide(f.mcp.browser, approval, "reject")).state.kind).toBe("succeeded");
  expect(google.labelRequests.map((request) => request.url)).toEqual([LABELS_URL]);
  expect(await answer(await getApproval(f.mcp, approval))).toEqual({
    status: "success",
    result: { account: PERSONAL, labels },
  });
  expect((await listLabelsRecord()).outcome).toBe("success");
  expect((await callRows()).filter((row) => row.tool === "get_approval")).toHaveLength(2);
  expect(await approvalRow(approval)).toMatchObject({
    state: "approved",
    outcome: "success",
    arguments: null,
    decided_at: NOW,
  });
});

it("runs nothing when the owner rejects", async () => {
  const f = await fixture();
  await setting(f, "ask");
  const { approval } = await ask(f);
  const before = googleTraffic().length;
  expect((await decide(f.mcp.browser, approval, "reject")).state.kind).toBe("rejected");
  expect(await answer(await getApproval(f.mcp, approval))).toEqual({ status: "rejected" });
  expect(googleTraffic().slice(before)).toEqual([]);
  expect((await listLabelsRecord()).outcome).toBe("rejected");
  expect(await approvalRow(approval)).toMatchObject({ state: "rejected", arguments: null });
});

it("runs nothing for an Approve that arrives at expires_at", async () => {
  const f = await fixture();
  await setting(f, "ask");
  const { approval } = await ask(f);
  const page = await pageProps(await f.mcp.browser.get(`/approvals/${approval}`));
  const before = googleTraffic().length;
  vi.spyOn(Date, "now").mockReturnValue(NOW + HOUR);
  // The owner's sign-in and the client's access token also last one hour; renew both.
  await f.mcp.browser.authenticate();
  await f.mcp.keepTokens(await f.mcp.refresh());
  const decided = await decide(f.mcp.browser, approval, "approve", {
    digest: String(page.state.digest),
  });
  expect(decided.state.kind).toBe("expired");
  expect(await answer(await getApproval(f.mcp, approval))).toEqual({ status: "expired" });
  expect(googleTraffic().slice(before)).toEqual([]);
  expect((await listLabelsRecord()).outcome).toBe("expired");
});

it("ends a waiting approval when the owner sets the tool to deny, and it stays ended", async () => {
  const f = await fixture();
  await setting(f, "ask");
  const { approval } = await ask(f);
  const page = await pageProps(await f.mcp.browser.get(`/approvals/${approval}`));
  await setting(f, "deny");
  await setting(f, "ask");
  const before = googleTraffic().length;
  const decided = await decide(f.mcp.browser, approval, "approve", {
    digest: String(page.state.digest),
  });
  expect(decided.state).toMatchObject({ kind: "ended", by: "tool" });
  const refused = await answer(await getApproval(f.mcp, approval));
  expect(refused.status).toBe("refused");
  expect(typeof refused.message).toBe("string");
  expect(googleTraffic().slice(before)).toEqual([]);
  expect((await listLabelsRecord()).outcome).toBe("refused");
  expect(await approvalRow(approval)).toMatchObject({ state: "refused", arguments: null });
});

it("gives one refusal for an approval that is not the calling connection's", async () => {
  const f = await fixture();
  await setting(f, "ask");
  const { approval } = await ask(f);
  const other = await new McpClient().connect("Work laptop");
  const texts = new Set<string>();
  for (const [mcp, value] of [
    [other, approval],
    [f.mcp, crypto.randomUUID()],
    [f.mcp, "not an ID"],
    [f.mcp, 7],
  ] as const)
    texts.add(await expectError(await getApproval(mcp, value), "approval_not_available", /./));
  expect(texts.size, "the refusal never says why").toBe(1);
  expect(
    (await callRows()).filter((row) => row.tool === "get_approval").map((row) => row.outcome),
  ).toEqual(["refused", "refused", "refused", "refused"]);
});

it("lets only the signed-in owner decide", async () => {
  const f = await fixture();
  await setting(f, "ask");
  const { approval } = await ask(f);
  const page = await pageProps(await f.mcp.browser.get(`/approvals/${approval}`));
  const digest = String(page.state.digest);
  const before = googleTraffic().length;
  const stranger = new Browser();
  const other = new Browser();
  await other.authenticate({ email: "someone.else@example.net" });
  for (const browser of [stranger, other])
    for (const action of ["approve", "reject"] as const)
      expect((await browser.post(`/approvals/${approval}/${action}`, { digest })).status).toBe(403);
  // A cross-site request from the owner's own browser is refused too.
  expect(
    (
      await f.mcp.browser.post(
        `/approvals/${approval}/approve`,
        { digest },
        { origin: "https://evil.example" },
      )
    ).status,
  ).toBe(403);
  expect((await stranger.get(`/approvals/${approval}`)).status).toBe(403);
  expect((await f.mcp.browser.get(`/approvals/${crypto.randomUUID()}`)).status).toBe(404);
  expect(googleTraffic().slice(before)).toEqual([]);
  expect(await approvalRow(approval)).toMatchObject({ state: "waiting" });
  expect((await listLabelsRecord()).outcome).toBe("pending");
});

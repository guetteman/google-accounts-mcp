import { env } from "cloudflare:workers";
import { Effect } from "effect";
import { expect, it, vi } from "vite-plus/test";
import "./support/account-checks";
import { TOOLS } from "../src/mcp/tools";
import { decideApproval, readApproval } from "../src/approvals/store";
import { readOwner } from "../src/owner/owner";
import { parseApprovalId } from "../src/approvals/model";
import type { ApprovalPageProps, ApprovalState } from "../src/approvals/model";
import { renderPage } from "../src/pages/render";
import { previews } from "../src/pages/previews";
import { fixture } from "./support/permissions";
import { ask, approve, page, post, setting } from "./support/approvals";
import { NOW } from "./support/accounts";
import { google } from "./support/google";
import { ORIGIN, textOf } from "./support/worker";
import type { TestEnv } from "./env";

it("renders plain notes before values and warnings after the whole call and before Approve", async () => {
  const props = previews["approval-waiting-notes"] as ApprovalPageProps;
  const html = (await renderPage(props).text()).replace(/<script[\s\S]*?<\/script>/g, "");
  const plain = props.request.notes[0]!.text;
  const warning = props.request.notes[1]!.text;
  const text = textOf(html);
  expect(html).toContain(`<p class="text-base/7">${plain}</p>`);
  expect(text.indexOf(plain)).toBeGreaterThan(
    text.indexOf("This page's own words are never shaded."),
  );
  expect(html.indexOf(plain)).toBeLessThan(html.indexOf("<figure"));
  for (const quoted of html.matchAll(/<(blockquote|bdi)\b[^>]*>[\s\S]*?<\/\1>/g))
    expect(quoted[0]).not.toContain(plain);
  const alert = /<div\b[^>]*role="alert"[\s\S]*?<\/div><\/div>/.exec(html)?.[0];
  expect(alert).toBeDefined();
  expect(alert).toContain("bg-warning");
  expect(alert).toContain("lucide-triangle-alert");
  expect(alert).toMatch(new RegExp(`<div[^>]*data-slot="alert-title"[^>]*>${warning}</div>`));
  expect(html.indexOf(warning)).toBeGreaterThan(html.lastIndexOf("</blockquote>"));
  expect(html.indexOf(warning)).toBeGreaterThan(html.indexOf("That is the whole call."));
  expect(html.indexOf(warning)).toBeLessThan(html.indexOf(">Approve</button>"));
});

it.each([
  { kind: "waiting", shown: false, changed: false, digest: null },
  { kind: "succeeded" },
] satisfies ApprovalState[])(
  "hides view notes for a $kind page without a shown view",
  async (state) => {
    const source = previews["approval-waiting-notes"] as ApprovalPageProps;
    const text = textOf(await renderPage({ ...source, state }).text());
    for (const note of source.request.notes) expect(text).not.toContain(note.text);
  },
);

it("renders who asks, the account, the full request and UTC times before Approve", async () => {
  const f = await fixture();
  await env.DB.prepare("UPDATE accounts SET hd = ? WHERE id = ?")
    .bind("northwind.example", f.northwind.id)
    .run();
  await setting(f, "ask", f.northwind);
  await f.mcp.browser.post(`/connections/${f.connection.id}/name`, { name: "Review workstation" });
  const id = await ask(f, { account: f.northwind.email });
  const tool = TOOLS.find((t) => t.kind === "account")!;
  if (tool.kind !== "account") throw new Error("Missing account tool");
  vi.spyOn(tool.view, "values").mockReturnValue(
    Effect.succeed([{ name: "Request", text: "Last request value", from: "agent" }]),
  );
  const html = await (await f.mcp.browser.get(`/approvals/${id}`)).text();
  const text = textOf(html);
  for (const value of [
    "Review workstation",
    "Claude Code",
    "Northwind",
    f.northwind.email,
    "a Workspace account",
    "Asked 0 minutes ago, at 12:00 UTC",
    "Expires in 60 minutes, at 13:00 UTC",
    "Last request value",
  ])
    expect(text).toContain(value);
  expect(text).toContain("Review workstation wants to list the Gmail labels of Northwind");
  expect(html.indexOf("Last request value")).toBeGreaterThan(0);
  expect(html.indexOf(">Approve</button>")).toBeGreaterThan(html.indexOf("Last request value"));
});

it.each([
  [
    "running",
    "Approved. The call is running.",
    "You approved this on Nov 9 at 12:00 UTC. A call can take up to 25 seconds.",
  ],
  [
    "succeeded",
    "Approved. The call succeeded.",
    "You approved this on Nov 9 at 12:00 UTC, and the call ran once.",
  ],
  [
    "failed",
    "Approved. The call failed.",
    "You approved this on Nov 9 at 12:00 UTC. The call failed.",
  ],
  [
    "unknown",
    "Approved. The outcome is unknown.",
    "You approved this on Nov 9 at 12:00 UTC. The server does not know whether Google completed the call.",
  ],
  ["rejected", "Rejected. Nothing ran.", "You rejected this on Nov 9 at 12:00 UTC."],
  [
    "expired",
    "Expired. Nothing ran.",
    "Nobody decided before Nov 9 at 13:00 UTC, one hour after the agent asked.",
  ],
  [
    "tool",
    "No longer allowed. Nothing ran.",
    "While this request waited, you set List labels to Not allowed for Claude on Northwind",
  ],
  [
    "connection",
    "Connection ended. Nothing ran.",
    "While this request waited, the connection Claude ended. It was revoked.",
  ],
  [
    "account",
    "Account removed. Nothing ran.",
    "While this request waited, you removed the account Northwind from this server.",
  ],
])(
  "renders the recorded %s headline, detail and decision time",
  async (state, headline, detail) => {
    const f = await fixture();
    await env.DB.prepare("UPDATE accounts SET hd = ? WHERE id = ?")
      .bind("northwind.example", f.northwind.id)
      .run();
    await setting(f, "ask", f.northwind);
    const id = await ask(f, { account: f.northwind.email });
    if (state === "succeeded" || state === "failed") {
      if (state === "failed") google.labelAnswers.push(() => new Response(null, { status: 503 }));
      await approve(f, id);
    } else if (state === "running" || state === "unknown") {
      const owner = await Effect.runPromise(readOwner(env.DB));
      const ctx = { db: env.DB, owner: { generation: owner.generation, email: owner.email! } };
      const stored = (await Effect.runPromise(readApproval(ctx, parseApprovalId(id)!, NOW)))!;
      await Effect.runPromise(
        decideApproval(ctx, {
          id: stored.id,
          at: NOW,
          action: "approve",
        }),
      );
      if (state === "unknown") vi.spyOn(Date, "now").mockReturnValue(NOW + 30_000);
    } else if (state === "rejected") await post(f, id, "reject");
    else if (state === "expired") {
      vi.spyOn(Date, "now").mockReturnValue(NOW + 3_600_000);
      await f.mcp.browser.authenticate();
    } else if (state === "tool") await setting(f, "deny", f.northwind);
    else
      await f.mcp.browser.post(
        state === "connection"
          ? `/connections/${f.connection.id}/revoke`
          : `/accounts/${f.northwind.id}/remove`,
      );
    const html = await (await f.mcp.browser.get(`/approvals/${id}`)).text();
    const heading = textOf(/<h1[^>]*>([\s\S]*?)<\/h1>/.exec(html)![1]!);
    expect(heading).toBe(headline);
    // bdi is inline; the HTML helper inserts spaces at its boundaries.
    const text = textOf(html).replace(/\s+([.,])/g, "$1");
    expect(text).toContain(detail);
    expect(text).toContain("a Workspace account");
    if (state === "failed")
      expect(text).toContain(
        `Google could not complete the request for ${f.northwind.email}. Try again later.`,
      );
  },
);

it("explains an unconfirmed decision without claiming its answer was lost", async () => {
  const f = await fixture();
  await env.DB.prepare("UPDATE accounts SET hd = ? WHERE id = ?")
    .bind("northwind.example", f.northwind.id)
    .run();
  await setting(f, "ask");
  const id = await ask(f);
  const props = await page(f, id);
  const text = textOf(await renderPage({ ...props, unconfirmed: true }).text());
  expect(text).toContain("Couldn't confirm your decision. Reload this page.");
  expect(text).toContain(
    "This page could not confirm whether your decision counted. Check what the server recorded before deciding again.",
  );
});

it("loads a stored Ask first setting into props and the hydrated checked segment", async () => {
  const f = await fixture();
  await env.DB.prepare("UPDATE accounts SET hd = ? WHERE id = ?")
    .bind("northwind.example", f.northwind.id)
    .run();
  await setting(f, "ask");
  const response = await f.mcp.browser.get(`/connections/${f.connection.id}`);
  const html = await response.text();
  const props = JSON.parse(
    /<script id="page-props" type="application\/json">([\s\S]*?)<\/script>/.exec(html)![1]!,
  );
  expect(props.settings[`${f.personal.id}:list_labels`]).toBe("ask");
  const result = await (
    await (env as TestEnv).TEST_BROWSER.fetch("http://browser/hydrate", {
      method: "POST",
      body: JSON.stringify({
        url: `${ORIGIN}/connections/${f.connection.id}`,
        html,
        headers: Object.fromEntries(response.headers),
        connection: true,
      }),
    })
  ).json<{ controls: { name: string; selected: string }[]; errors: string[] }>();
  expect(result.errors).toEqual([]);
  expect(result.controls).toContainEqual({
    name: "List labels on Personal for Claude",
    selected: "Ask first",
  });
});

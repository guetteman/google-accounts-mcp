import { env } from "cloudflare:workers";
import { expect, vi } from "vite-plus/test";
import type { FramePage } from "../../src/pages/page";
import { seedAccount } from "./accounts";
import { Browser } from "./browser";
import { NOW, pinOwner, seedConnection } from "./connections";
import { decodeEntities } from "./worker";

export type ActivityProps = Extract<FramePage, { _tag: "Activity" }>;
export async function activityFixture() {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  await pinOwner();
  const browser = new Browser();
  await browser.authenticate();
  const connection = await seedConnection({ name: "Laptop" });
  const account = await seedAccount({ name: "Personal" });
  return { browser, connection, account };
}
export async function record(
  connection: string,
  account: string | null,
  overrides: {
    id?: number;
    at?: number;
    tool?: string | null;
    outcome?: string | null;
    reason?: string | null;
    also?: Array<{ account: string; tool: string }>;
  } = {},
) {
  const row = await env.DB.prepare(
    "INSERT INTO calls (id,connection_id,account_id,tool,at,outcome,also,reason) VALUES (?,?,?,?,?,?,?,?) RETURNING id",
  )
    .bind(
      overrides.id ?? null,
      connection,
      account,
      overrides.tool === undefined ? "read_thread" : overrides.tool,
      overrides.at ?? NOW,
      overrides.outcome === undefined ? "success" : overrides.outcome,
      overrides.also ? JSON.stringify(overrides.also) : null,
      overrides.reason ?? null,
    )
    .first<{ id: number }>();
  return row!.id;
}
export async function approval(
  call: number,
  connection: string,
  state = "waiting",
  expires = NOW + 3600000,
  endedBy: "tool" | "connection" | "account" | null = null,
) {
  const id = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO approvals (id,generation,connection_id,call_id,tool,uses,created_at,expires_at,state,decided_at,arguments,ended_by)
    VALUES (?,1,?,?,'read_thread','[]',?,?,?,?,?,?)`)
    .bind(
      id,
      connection,
      call,
      NOW - 60000,
      expires,
      state,
      ["approved", "rejected"].includes(state) ? NOW - 30000 : null,
      state === "waiting" ? "sealed" : null,
      endedBy,
    )
    .run();
  return id;
}
export function activityProps(html: string): ActivityProps {
  const raw = /<script id="page-props" type="application\/json">([\s\S]*?)<\/script>/.exec(
    html,
  )?.[1];
  expect(raw).toBeDefined();
  const props = JSON.parse(raw!) as ActivityProps;
  expect(props._tag).toBe("Activity");
  return props;
}
export function link(html: string, label: string): string | null {
  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)) {
    if (match[2]!.replace(/<[^>]+>/g, "").trim() !== label) continue;
    return decodeEntities(/href="([^"]*)"/.exec(match[1]!)![1]!);
  }
  return null;
}

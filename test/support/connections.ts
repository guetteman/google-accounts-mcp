import { env } from "cloudflare:workers";
import { expect } from "vite-plus/test";
import { resetPlan } from "../../src/owner/reset";
import { ownerRow, setOwner } from "./db";
import { OWNER_EMAIL } from "./worker";

export const DAY = 24 * 60 * 60 * 1000;
// Future relative to the runtime clock: real local KV must not reject fake-clock expirations.
export const NOW = Date.UTC(2030, 10, 9, 12);
export interface ConnectionRow {
  id: string;
  generation: number;
  grant_id: string;
  app: "claude-code" | "claude-hosted" | "chatgpt";
  name: string;
  state: "active" | "revoked";
  created_at: number;
  expires_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}
export async function rows(): Promise<ConnectionRow[]> {
  return (
    await env.DB.prepare("SELECT * FROM connections ORDER BY created_at, id").all<ConnectionRow>()
  ).results;
}
export async function onlyConnection() {
  const all = await rows();
  expect(all).toHaveLength(1);
  return all[0]!;
}
export async function seedConnection(overrides: Partial<ConnectionRow> = {}) {
  const row: ConnectionRow = {
    id: crypto.randomUUID(),
    generation: 1,
    grant_id: crypto.randomUUID(),
    app: "claude-code",
    name: "Work laptop",
    state: "active",
    created_at: NOW,
    expires_at: NOW + 90 * DAY,
    last_used_at: null,
    revoked_at: null,
    ...overrides,
  };
  await env.DB.prepare(
    "INSERT INTO connections (id, generation, grant_id, app, name, state, created_at, expires_at, last_used_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      row.id,
      row.generation,
      row.grant_id,
      row.app,
      row.name,
      row.state,
      row.created_at,
      row.expires_at,
      row.last_used_at,
      row.revoked_at,
    )
    .run();
  return row;
}
export const pinOwner = () => setOwner({ state: "pinned", generation: 1, email: OWNER_EMAIL });
export async function resetOwner() {
  const row = await ownerRow();
  expect(row).not.toBeNull();
  const plan = resetPlan(row!);
  await env.DB.batch(plan.statements.map((sql) => env.DB.prepare(sql)));
}

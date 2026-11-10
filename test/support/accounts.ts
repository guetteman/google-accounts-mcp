import { loadCredential } from "../../src/accounts/store";
import { env } from "cloudflare:workers";
import { Effect, Result } from "effect";
import { expect } from "vite-plus/test";
import { readConfig } from "../../src/config";
import type { AccountId, Credential, Health } from "../../src/accounts/model";
import { withGoogle } from "../../src/accounts/tokens";
import { readOwner, type Owner } from "../../src/owner/owner";
import { Browser } from "./browser";
import { b64url } from "./oauth";
import { google, GMAIL, SCOPES, token, type CodeOptions } from "./google";
import { observedBodies, OWNER_EMAIL, testEnv, textOf } from "./worker";

export const NOW = Date.parse("2030-11-09T12:00:00Z");
export interface AccountRow {
  id: AccountId;
  generation: number;
  sub: string;
  email: string;
  name: string;
  hd: string | null;
  state: "live" | "removed";
  created_at: number;
  removed_at: number | null;
  version: number;
  scopes: string;
  health: Health;
  blocked_until: number | null;
  refresh_token: string | null;
  access_token: string | null;
  access_expires_at: number | null;
}
/** Independent AES-GCM fixture encoder, so the token tests don't depend on production encryption. */
export async function fixtureSeal(
  context: string,
  value: string,
  bytes = Uint8Array.from({ length: 32 }, () => 187),
) {
  const key = await crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt"]);
  const kid = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)).slice(0, 8)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(context) },
    key,
    new TextEncoder().encode(value),
  );
  return `v1.${kid}.${b64url(iv)}.${b64url(new Uint8Array(sealed))}`;
}
export async function fixtureOpen(context: string, value: string) {
  const parts = value.split(".");
  const decode = (s: string) =>
    Uint8Array.from(atob(s.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from({ length: 32 }, () => 187),
    "AES-GCM",
    false,
    ["decrypt"],
  );
  return new TextDecoder().decode(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: decode(parts[2]!), additionalData: new TextEncoder().encode(context) },
      key,
      decode(parts[3]!),
    ),
  );
}
export async function seedAccount(overrides: Partial<AccountRow> = {}) {
  const id = crypto.randomUUID() as AccountId;
  const row: AccountRow = {
    id,
    generation: 1,
    sub: id,
    email: OWNER_EMAIL,
    name: OWNER_EMAIL,
    hd: null,
    state: "live",
    created_at: NOW,
    removed_at: null,
    version: 1,
    scopes: JSON.stringify(SCOPES),
    health: "ready",
    blocked_until: null,
    refresh_token: await fixtureSeal(`${id}:refresh`, google.issueRefreshToken()),
    access_token: await fixtureSeal(`${id}:access`, token()),
    access_expires_at: NOW + 3000000,
    ...overrides,
  };
  await env.DB.prepare(
    `INSERT INTO accounts (${Object.keys(row).join(",")}) VALUES (${Object.keys(row)
      .map(() => "?")
      .join(",")})`,
  )
    .bind(...Object.values(row))
    .run();
  return row;
}
export const accounts = async () =>
  (await env.DB.prepare("SELECT * FROM accounts ORDER BY created_at, id").all<AccountRow>())
    .results;
export async function credential(id: AccountId): Promise<Credential> {
  const row = await Effect.runPromise(readOwner(env.DB));
  const value = await Effect.runPromise(
    loadCredential(env.DB, { generation: row.generation, email: row.email! }, id),
  );
  if (!value) throw new Error("Test requires a valid existing credential");
  return value;
}
export async function ownerBrowser() {
  const browser = new Browser();
  await browser.authenticate();
  await browser.get("/accounts");
  return browser;
}
export async function start(browser: Browser, id?: string) {
  const response = await browser.post(id ? `/accounts/${id}/reconnect` : "/accounts/connect");
  expect(response.status, "owner can start a Google flow").toBe(200);
  const body = await response.json<{ outcome: string; url: string }>();
  expect(body.outcome).toBe("ok");
  return { url: new URL(body.url), response };
}
export async function finish(
  browser: Browser,
  url: URL,
  options: CodeOptions = {},
  workerEnv?: Env,
) {
  const callback = google.issueCode(url, options);
  const response = await browser.get(callback, { env: workerEnv });
  expect(response.status).toBe(303);
  expect(response.headers.get("Location")).toBe("/accounts");
  return { callback, response, text: textOf(await (await browser.get("/accounts")).text()) };
}
export async function call(
  id: AccountId,
  db = env.DB,
  snapshot?: Credential,
  workerEnv = testEnv(),
) {
  const config = readConfig(workerEnv);
  if (Result.isFailure(config)) throw new Error("Invalid test config");
  const row = await Effect.runPromise(readOwner(env.DB));
  const owner: Owner = { generation: row.generation, email: row.email! };
  const result = await Effect.runPromise(
    Effect.result(
      withGoogle(
        { db, config: config.success, owner, now: Date.now },
        snapshot ?? (await credential(id)),
        (access) => new Request(GMAIL, { headers: { Authorization: `Bearer ${access}` } }),
      ),
    ),
  );
  if (Result.isFailure(result)) {
    observedBodies.push(result.failure);
    return { error: result.failure._tag, detail: result.failure };
  }
  const body = await result.success.text();
  observedBodies.push({
    body,
    headers: [...result.success.headers],
    cookies: result.success.headers.getSetCookie(),
  });
  return { status: result.success.status, body };
}

import { env } from "cloudflare:workers";
import { expect, it } from "vite-plus/test";
import { app } from "../src/http/app";
import { onlyConnection, seedConnection } from "./support/connections";
import { Browser } from "./support/browser";
import {
  committedConnectionFailureDb,
  dump,
  failingKv,
  kvDump,
  responseLostConnectionWriteDb,
  statementFailingDb,
} from "./support/db";

app.get("/__test/cookie-jar", (c) => {
  const headers = new Headers();
  const url = new URL(c.req.url);
  if (url.searchParams.has("set")) {
    headers.append(
      "Set-Cookie",
      "__Host-one=one; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600",
    );
    headers.append(
      "Set-Cookie",
      "__Host-two=two; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600",
    );
  }
  if (url.searchParams.has("clear"))
    headers.append("Set-Cookie", "__Host-one=; Path=/; Secure; Max-Age=0");
  return new Response(c.req.header("Cookie") ?? "", { headers });
});
it("keeps both binding cookies on their own origin and clears only the expired cookie", async () => {
  const browser = new Browser();
  await browser.get("/__test/cookie-jar?set");
  expect(await (await browser.get("/__test/cookie-jar")).text()).toBe(
    "__Host-one=one; __Host-two=two",
  );
  expect(await (await browser.get("https://other.example.com/__test/cookie-jar")).text()).toBe("");
  await browser.get("/__test/cookie-jar?clear");
  expect(await (await browser.get("/__test/cookie-jar")).text()).toBe("__Host-two=two");
});

it("includes every KV value in unchanged-state checks", async () => {
  await env.OAUTH_KV.put("first", "one", { metadata: { kind: "test" } });
  const before = await dump();
  await env.OAUTH_KV.put("first", "two", { metadata: { kind: "test" } });
  expect(await dump()).not.toEqual(before);
  expect(await kvDump()).toEqual([{ name: "first", value: "two", metadata: { kind: "test" } }]);
});

it("fails every KV method or only token writes as selected", async () => {
  const all = failingKv("all");
  for (const operation of [
    () => all.get("key"),
    () => all.put("key", "value"),
    () => all.delete("key"),
    () => all.getWithMetadata("key"),
    () => all.list(),
  ])
    expect(operation).toThrow("KV unavailable");
  const token = failingKv("token-put");
  await token.put("grant:test", "retained");
  expect(await token.get("grant:test")).toBe("retained");
  expect(() => token.put("token:test", "value")).toThrow("KV unavailable");
});

it("injects a connection failure without breaking the owner read", async () => {
  const db = statementFailingDb(/connections/);
  expect(await db.prepare("SELECT state FROM owner WHERE id = 1").first()).toEqual({
    state: "unpinned",
  });
  await expect(db.prepare("SELECT * FROM connections").all()).rejects.toThrow("D1_ERROR");
});
it("can lose the D1 answer after a real connection write committed", async () => {
  const row = await seedConnection();
  const lost = responseLostConnectionWriteDb();
  await expect(
    lost
      .prepare("UPDATE connections SET name = ? WHERE id = ?")
      .bind("Personal laptop", row.id)
      .run(),
  ).rejects.toThrow("response lost after commit");
  expect((await onlyConnection()).name).toBe("Personal laptop");
  const id = crypto.randomUUID();
  const db = committedConnectionFailureDb();
  const insert = db
    .prepare(
      "INSERT INTO connections SELECT ?, generation, ?, app, name, state, created_at, expires_at, last_used_at, revoked_at FROM connections WHERE id = ?",
    )
    .bind(id, crypto.randomUUID(), row.id);
  await expect(db.batch([insert])).rejects.toThrow("response lost after commit");
  expect(await env.DB.prepare("SELECT id FROM connections WHERE id = ?").bind(id).first()).toEqual({
    id,
  });
});

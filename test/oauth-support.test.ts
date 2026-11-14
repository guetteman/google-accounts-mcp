import { env } from "cloudflare:workers";
import { expect, it } from "vite-plus/test";
import { app } from "../src/http/app";
import { Browser } from "./support/browser";
import { dump, kvDump } from "./support/db";

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

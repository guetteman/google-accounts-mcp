import { expect, it } from "vite-plus/test";
import type { Page } from "../src/pages/page";
import { renderPage } from "../src/pages/render";
import { OWNER_EMAIL } from "./support/worker";

const host = "x</script><script>alert(1)</script>&<>\u2028";

it("escapes HTML delimiters and preserves the exact host in hydration props", async () => {
  const page: Page = {
    _tag: "Accounts",
    frame: { host, current: "accounts", ownerEmail: OWNER_EMAIL },
    accounts: [],
    alert: null,
    requiredGmailScopes: 5,
  };
  const html = await renderPage(page).text();
  expect(html).not.toContain("<script>alert(1)</script>");
  const blob = /<script\b[^>]*id="page-props"[^>]*>([\s\S]*?)<\/script>/i.exec(html)?.[1];
  expect(blob).toBeDefined();
  expect(blob).not.toMatch(/[<>&\u2028]/);
  expect(JSON.parse(blob!)).toEqual(page);
});

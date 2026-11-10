import { describe, expect, it } from "vite-plus/test";
import { connectionPage } from "./support/connection-page";
import { renderPage } from "../src/pages/render";
import { OWNER_EMAIL } from "./support/worker";

const host = "x</script><script>alert(1)</script>&<>\u2028";

describe("hydration props", () => {
  it.each(["accounts", "connections"] as const)(
    "escapes HTML delimiters and preserves the exact host in the %s props",
    async (current) => {
      const frame = { host, current, ownerEmail: OWNER_EMAIL };
      const page: import("../src/pages/page").Page =
        current === "accounts"
          ? { _tag: "Accounts", frame, accounts: [], alert: null, requiredGmailScopes: 5 }
          : { _tag: "Connections", frame, connections: [], mcpUrl: `https://${host}/mcp` };
      const html = await renderPage(page).text();
      expect(html).not.toContain("<script>alert(1)</script>");
      const blob = /<script\b[^>]*id="page-props"[^>]*>([\s\S]*?)<\/script>/i.exec(html)?.[1];
      expect(blob).toBeDefined();
      expect(blob).not.toMatch(/[<>&\u2028]/);
      expect(JSON.parse(blob!)).toEqual(page);
    },
  );
});

it("escapes HTML delimiters and preserves the exact host in connection page props", async () => {
  const page = { ...connectionPage, frame: { ...connectionPage.frame, host } };
  const html = await renderPage(page as unknown as import("../src/pages/page").Page).text();
  expect(html).not.toContain("<script>alert(1)</script>");
  const blob = /<script\b[^>]*id="page-props"[^>]*>([\s\S]*?)<\/script>/i.exec(html)?.[1];
  expect(blob).toBeDefined();
  expect(blob).not.toMatch(/[<>&\u2028]/);
  expect(JSON.parse(blob!)).toEqual(page);
});

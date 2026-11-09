import { describe, expect, it } from "vite-plus/test";
import { renderPage } from "../src/pages/render";
import { OWNER_EMAIL } from "./support/worker";

const host = "x</script><script>alert(1)</script>&<>\u2028";

describe("hydration props", () => {
  it.each(["accounts", "connections"] as const)(
    "escapes HTML delimiters and preserves the exact host in the %s props",
    async (current) => {
      const page = {
        _tag: current === "accounts" ? ("Accounts" as const) : ("Connections" as const),
        frame: { host, current, ownerEmail: OWNER_EMAIL },
      };
      const html = await renderPage(page).text();
      expect(html).not.toContain("<script>alert(1)</script>");
      const blob = /<script\b[^>]*id="page-props"[^>]*>([\s\S]*?)<\/script>/i.exec(html)?.[1];
      expect(blob).toBeDefined();
      expect(blob).not.toMatch(/[<>&\u2028]/);
      expect(JSON.parse(blob!)).toEqual(page);
    },
  );
});

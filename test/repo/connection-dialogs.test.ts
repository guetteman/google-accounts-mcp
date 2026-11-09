import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { chromium, type Browser } from "playwright-core";
import { build } from "vite-plus";
import { afterAll, beforeAll, expect, it } from "vite-plus/test";

let browser: Browser;
let origin: string;
let server: ReturnType<typeof createServer>;

beforeAll(async () => {
  // Bundle the real page and its styles. Worker tests own authorization and D1 effects;
  // this browser test owns the controls that choose an action and its submitted fields.
  const bundle = await build({
    configFile: false,
    logLevel: "silent",
    plugins: [tailwindcss()],
    resolve: { alias: { "@": fileURLToPath(new URL("../../src", import.meta.url)) } },
    build: {
      write: false,
      minify: false,
      rollupOptions: {
        input: fileURLToPath(new URL("../browser/connections.tsx", import.meta.url)),
      },
    },
  });
  const outputs = (Array.isArray(bundle) ? bundle : [bundle]).flatMap((result) =>
    "output" in result ? result.output : [],
  );
  const assets = new Map(
    outputs.map((asset) => [
      `/${asset.fileName}`,
      asset.type === "chunk" ? asset.code : asset.source,
    ]),
  );
  const entry = outputs.find((asset) => asset.type === "chunk" && asset.isEntry)!;
  const styles = outputs.filter((asset) => asset.fileName.endsWith(".css"));
  const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">${styles.map((asset) => `<link rel="stylesheet" href="/${asset.fileName}">`).join("")}</head><body><div id="root"></div><script type="module" src="/${entry.fileName}"></script></body></html>`;
  server = createServer((request, response) => {
    const path = request.url!;
    if (path === "/" || path === "/consent") {
      response.setHeader("Content-Type", "text/html");
      response.end(html);
    } else if (assets.has(path)) {
      response.setHeader("Content-Type", path.endsWith(".css") ? "text/css" : "text/javascript");
      response.end(assets.get(path));
    } else {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch({ headless: true, channel: "chromium" });
}, 30_000);

afterAll(async () => {
  await browser?.close();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

it.each([390, 1280])(
  "submits only the chosen connection action and name at %s px",
  async (width) => {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    try {
      await page.route("**/connections/*", (route) =>
        route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({ outcome: "already_ended" }),
        }),
      );
      await page.goto(origin);
      const menu = page
        .getByRole("button", { name: "Actions for Work laptop", exact: true })
        .filter({ visible: true });
      await menu.click();
      await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
      await page.getByRole("textbox", { name: "Name", exact: true }).fill("Personal laptop");
      const renameRequest = page.waitForRequest((request) => request.method() === "POST");
      await page.getByRole("button", { name: "Save", exact: true }).click();
      const rename = await renameRequest;
      expect(new URL(rename.url()).pathname).toBe(
        "/connections/11111111-1111-4111-8111-111111111111/name",
      );
      expect(Object.fromEntries(new URLSearchParams(rename.postData()!))).toEqual({
        name: "Personal laptop",
      });
      await page.getByRole("status").waitFor();
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      await menu.click();
      await page.getByRole("menuitem", { name: "Revoke", exact: true }).click();
      const revokeRequest = page.waitForRequest((request) => request.method() === "POST");
      await page.getByRole("button", { name: "Revoke", exact: true }).click();
      const revoke = await revokeRequest;
      expect(new URL(revoke.url()).pathname).toBe(
        "/connections/11111111-1111-4111-8111-111111111111/revoke",
      );
      expect(revoke.postData() ?? "").toBe("");
    } finally {
      await page.close();
    }
  },
  15_000,
);

it.each(["consent", "rename"])(
  "lets the owner type one hundred emoji into the %s name field",
  async (kind) => {
    const page = await browser.newPage();
    try {
      await page.goto(`${origin}${kind === "consent" ? "/consent" : "/"}`);
      if (kind === "rename") {
        await page
          .getByRole("button", { name: "Actions for Work laptop", exact: true })
          .filter({ visible: true })
          .click();
        await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
      }
      const field = page.getByRole("textbox", {
        name: kind === "consent" ? "Connection name" : "Name",
        exact: true,
      });
      await field.fill("");
      await field.pressSequentially("😀".repeat(100));
      expect(await field.inputValue()).toBe("😀".repeat(100));
      expect(await field.getAttribute("required")).not.toBeNull();
      expect(await field.getAttribute("maxlength")).toBeNull();
    } finally {
      await page.close();
    }
  },
);

import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { chromium } from "playwright-core";
import { build } from "vite-plus";

// Miniflare runs this test-only service in Node, where Chromium can load the Worker's HTML.
export async function hydrateAccounts(input: {
  url: string;
  html: string;
  headers: Record<string, string>;
}) {
  const bundle = await build({
    configFile: false,
    logLevel: "silent",
    plugins: [tailwindcss()],
    resolve: { alias: { "@": fileURLToPath(new URL("../../src", import.meta.url)) } },
    build: {
      write: false,
      minify: false,
      rollupOptions: {
        input: ["src/pages/client.tsx", "src/styles.css"],
        output: { entryFileNames: "assets/[name].js", assetFileNames: "assets/[name][extname]" },
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
  const browser = await chromium.launch({ headless: true, channel: "chromium" });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.setDefaultTimeout(2000);
    const errors: string[] = [];
    let clientLoads = 0;
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.href === input.url)
        return route.fulfill({ body: input.html, headers: input.headers });
      // Worker tests render development asset URLs; serve the real compiled entry at either URL.
      const path =
        url.pathname === "/src/pages/client.tsx"
          ? "/assets/client.js"
          : url.pathname === "/src/styles.css"
            ? "/assets/styles.css"
            : url.pathname;
      if (path === "/@vite/client")
        return route.fulfill({ contentType: "text/javascript", body: "" });
      const body = assets.get(path);
      if (url.origin === new URL(input.url).origin && body !== undefined) {
        if (path === "/assets/client.js") clientLoads++;
        return route.fulfill({
          contentType: path.endsWith(".css")
            ? "text/css"
            : path.endsWith(".js")
              ? "text/javascript"
              : "font/woff2",
          body: typeof body === "string" ? body : Buffer.from(body),
        });
      }
      errors.push(`Unexpected browser request: ${url.pathname}`);
      await route.abort();
    });
    await page.goto(input.url);
    // An interactive dialog proves hydration finished; merely reading SSR text would pass without JS.
    try {
      await page
        .getByRole("button", { name: "Actions for Personal", exact: true })
        .filter({ visible: true })
        .click();
      await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
      await page.getByRole("dialog", { name: "Rename Personal", exact: true }).waitFor();
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
    } catch (error) {
      errors.push(String(error));
    }
    return {
      clientLoads,
      rows: await page.locator("tbody tr").allTextContents(),
      alerts: await page.getByRole("status").allTextContents(),
      errors,
    };
  } finally {
    await browser.close();
  }
}

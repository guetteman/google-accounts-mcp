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
      // Each answer the dialog cannot confirm keeps it open with its message.
      const answers = [
        [200, { outcome: "already_ended" }, "Work laptop already ended. Nothing changed."],
        [
          503,
          { outcome: "unavailable" },
          "Couldn't reach the database. Nothing changed. Try again in a minute.",
        ],
        [200, {}, "Couldn't confirm the change. Reload the page to see whether it happened."],
      ] as const;
      let answer = 0;
      await page.route("**/connections/*/*", (route) => {
        const [status, body] = answers[Math.min(answer++, answers.length - 1)]!;
        return route.fulfill({
          status,
          contentType: "application/json",
          body: JSON.stringify(body),
        });
      });
      await page.goto(origin);
      await expect
        .poll(
          () => page.getByRole("button", { name: "Actions for Work laptop", exact: true }).count(),
          { timeout: 1500 },
        )
        .toBe(1);
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
      for (const [index, [, , message]] of answers.entries()) {
        if (index > 0) await page.getByRole("button", { name: "Save", exact: true }).click();
        await expect.poll(() => page.getByRole("status").innerText()).toBe(message);
      }
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
        await expect
          .poll(
            () =>
              page.getByRole("button", { name: "Actions for Work laptop", exact: true }).count(),
            { timeout: 1500 },
          )
          .toBe(1);
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
      // Use Chromium's native text insertion, which enforces maxlength for emoji too.
      await page.keyboard.insertText("😀".repeat(100));
      expect(await field.inputValue()).toBe("😀".repeat(100));
      expect(await field.getAttribute("required")).not.toBeNull();
      expect(await field.getAttribute("maxlength")).toBeNull();
    } finally {
      await page.close();
    }
  },
);

it("renames the connection page after confirmation and removes all controls after revoke", async () => {
  const page = await browser.newPage();
  page.setDefaultTimeout(1500);
  try {
    await page.route("**/connections/*/*", (route) =>
      route.fulfill({ contentType: "application/json", body: JSON.stringify({ outcome: "ok" }) }),
    );
    await page.goto(origin);
    await expect
      .poll(
        () => page.getByRole("button", { name: "Actions for Work laptop", exact: true }).count(),
        { timeout: 1500 },
      )
      .toBe(1);
    await page.getByRole("button", { name: "Actions for Work laptop", exact: true }).click();
    await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
    await page.getByRole("textbox", { name: "Name", exact: true }).fill("Renamed agent");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByRole("heading", { name: "Renamed agent", exact: true }).waitFor();
    expect(await page.getByRole("radiogroup").count()).toBeGreaterThan(0);
    await page.getByRole("button", { name: "Actions for Renamed agent", exact: true }).click();
    await page.getByRole("menuitem", { name: "Revoke", exact: true }).click();
    await page.getByRole("button", { name: "Revoke", exact: true }).click();
    await expect.poll(() => page.getByRole("radiogroup", { includeHidden: true }).count()).toBe(0);
    expect(await page.getByText(/ended connection cannot be given access/i).count()).toBe(1);
  } finally {
    await page.close();
  }
});

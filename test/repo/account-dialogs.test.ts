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
        input: fileURLToPath(new URL("../browser/accounts.tsx", import.meta.url)),
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
    const path = new URL(request.url!, "http://localhost").pathname;
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
  "submits the chosen account rename and disconnect checkbox at %s px",
  async (width) => {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    page.setDefaultTimeout(2000);
    try {
      await page.route("**/accounts/**", (route) =>
        route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({ outcome: "not_found" }),
        }),
      );
      await page.goto(origin);
      const menu = page
        .getByRole("button", { name: "Actions for Personal", exact: true })
        .filter({ visible: true });
      await menu.click();
      await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
      await page.getByRole("textbox", { name: "Name", exact: true }).fill("Work");
      const renamed = page.waitForRequest((r) => r.method() === "POST");
      await page.getByRole("button", { name: "Save", exact: true }).click();
      const request = await renamed;
      expect(new URL(request.url()).pathname).toBe(
        "/accounts/11111111-1111-4111-8111-111111111111/name",
      );
      expect(new URLSearchParams(request.postData()!).get("name")).toBe("Work");
      await page.getByRole("status").waitFor();
      expect(await page.getByRole("status").innerText()).toContain(
        "This account no longer exists. Nothing changed. Reload the page.",
      );
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      await menu.click();
      await page.getByRole("menuitem", { name: "Remove", exact: true }).click();
      const box = page.getByRole("checkbox", {
        name: "Also disconnect this app in Google",
        exact: true,
      });
      expect(await box.isChecked()).toBe(false);
      const unchecked = page.waitForRequest((r) => r.method() === "POST");
      await page.getByRole("button", { name: "Remove", exact: true }).click();
      const kept = await unchecked;
      expect(new URL(kept.url()).pathname).toBe(
        "/accounts/11111111-1111-4111-8111-111111111111/remove",
      );
      expect(Object.fromEntries(new URLSearchParams(kept.postData() ?? ""))).toEqual({});
      // The failed removal keeps the dialog open with a warning.
      const warning = page.getByRole("alertdialog").getByRole("status");
      await warning.waitFor();
      expect(await warning.getAttribute("class")).toContain("bg-warning");
      await box.check();
      const removed = page.waitForRequest((r) => r.method() === "POST");
      await page.getByRole("button", { name: "Remove", exact: true }).click();
      expect(Object.fromEntries(new URLSearchParams((await removed).postData()!))).toEqual({
        disconnect: "1",
      });
    } finally {
      await page.close();
    }
  },
  15000,
);

it.each([390, 1280])(
  "navigates Connect and Reconnect to the returned URL and keeps not-found errors on the page at %s px",
  async (width) => {
    for (const action of ["Connect a Google account", "Reconnect"]) {
      for (const outcome of ["ok", "not_found"]) {
        const page = await browser.newPage({ viewport: { width, height: 900 } });
        page.setDefaultTimeout(2000);
        try {
          const destination = `https://google.example/authorize?flow=${encodeURIComponent(action)}`;
          const posts: string[] = [];
          await page.route("https://google.example/**", (route) =>
            route.fulfill({ contentType: "text/html", body: "Fake Google authorization" }),
          );
          await page.route("**/accounts/**", (route) => {
            posts.push(new URL(route.request().url()).pathname);
            return route.fulfill({
              contentType: "application/json",
              body: JSON.stringify({ outcome, url: destination }),
            });
          });
          await page.goto(origin);
          const navigations: string[] = [];
          page.on("request", (request) => {
            if (request.isNavigationRequest()) navigations.push(request.url());
          });
          const controls =
            action === "Reconnect"
              ? page
                  .locator(width < 768 ? '[data-slot="item"]' : "tbody tr")
                  .filter({ hasText: "Projects" })
              : page;
          await controls
            .getByRole("button", { name: action, exact: true })
            .filter({ visible: true })
            .click();
          if (outcome === "ok") {
            await page.waitForURL(destination);
            expect(navigations).toEqual([destination]);
          } else {
            const alert = page.getByRole("status");
            await alert.waitFor();
            expect(await alert.innerText()).toContain(
              "This account no longer exists. Nothing changed. Reload the page.",
            );
            expect(page.url()).toBe(`${origin}/`);
            expect(navigations).toEqual([]);
          }
          expect(posts).toEqual([
            action === "Reconnect"
              ? "/accounts/22222222-2222-4222-8222-222222222222/reconnect"
              : "/accounts/connect",
          ]);
        } finally {
          await page.close();
        }
      }
    }
  },
  15000,
);

it.each(["light", "dark"] as const)(
  "keeps the tinted Remove button at AA contrast in %s mode, including hover",
  async (colorScheme) => {
    const page = await browser.newPage({ viewport: { width: 390, height: 900 }, colorScheme });
    page.setDefaultTimeout(2000);
    try {
      await page.goto(origin);
      await page
        .getByRole("button", { name: "Actions for Personal", exact: true })
        .filter({ visible: true })
        .click();
      await page.getByRole("menuitem", { name: "Remove", exact: true }).click();
      const button = page.getByRole("button", { name: "Remove", exact: true });
      await button.waitFor();
      for (const hover of [false, true]) {
        if (hover) await button.hover();
        else await page.getByRole("heading", { name: "Remove Personal?", exact: true }).hover();
        await page.evaluate(async () => {
          await Promise.all(
            document
              .getAnimations()
              .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
              .map((a) => a.finished.catch(() => {})),
          );
        });
        const contrast = await button.evaluate((element) => {
          const canvas = document.createElement("canvas");
          canvas.width = canvas.height = 1;
          const context = canvas.getContext("2d")!;
          const rgb = (color: string) => {
            context.clearRect(0, 0, 1, 1);
            context.fillStyle = color;
            context.fillRect(0, 0, 1, 1);
            return Array.from(context.getImageData(0, 0, 1, 1).data);
          };
          const style = getComputedStyle(element);
          const base = rgb(
            getComputedStyle(element.closest('[role="alertdialog"]')!).backgroundColor,
          );
          const background = rgb(style.backgroundColor);
          const alpha = background[3]! / 255;
          const composed = background
            .slice(0, 3)
            .map((value, i) => value * alpha + base[i]! * (1 - alpha));
          const luminance = (color: number[]) =>
            color
              .slice(0, 3)
              .map((value) => {
                const channel = value / 255;
                return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
              })
              .reduce((sum, value, i) => sum + value * [0.2126, 0.7152, 0.0722][i]!, 0);
          const foreground = luminance(rgb(style.color)),
            behind = luminance(composed);
          return (Math.max(foreground, behind) + 0.05) / (Math.min(foreground, behind) + 0.05);
        });
        expect(contrast, `${colorScheme}, hover=${hover}`).toBeGreaterThanOrEqual(4.5);
      }
    } finally {
      await page.close();
    }
  },
  15000,
);

it.each([390, 1280])(
  "explains each account status and places Reconnect in its row or menu at %s px",
  async (width) => {
    const page = await browser.newPage({ viewport: { width, height: 1200 } });
    try {
      await page.goto(origin);
      const rows = page.locator(width < 768 ? '[data-slot="item"]' : "tbody tr");
      const cases = [
        ["Personal", "Ready", false],
        [
          "Projects",
          "Needs reconnect. Google stopped accepting this server's access. Reconnect to restore it.",
          true,
        ],
        [
          "Work",
          "Blocked by admin. The organization's admin blocked this app. The server checks again at most every 10 minutes, when an agent uses this account.",
          false,
        ],
        [
          "Research",
          "Missing access. Google granted 2 of the 5 permissions Gmail needs. Reconnect and check every box.",
          true,
        ],
        ["Recovery", "Can't read its stored access. Check TOKEN_KEY.", false],
      ] as const;
      for (const [name, status, fixable] of cases) {
        const row = rows.filter({
          has: page.getByRole("button", { name: `Actions for ${name}`, exact: true }),
        });
        await row.waitFor();
        expect(await row.innerText()).toContain(status);
        expect(await row.getByRole("button", { name: "Reconnect", exact: true }).count()).toBe(
          fixable ? 1 : 0,
        );
        await row.getByRole("button", { name: `Actions for ${name}`, exact: true }).click();
        expect(await page.getByRole("menuitem", { name: "Reconnect", exact: true }).count()).toBe(
          fixable ? 0 : 1,
        );
        await page.keyboard.press("Escape");
      }
    } finally {
      await page.close();
    }
  },
);

it("marks failure alerts as warnings and keeps success alerts neutral", async () => {
  const page = await browser.newPage();
  try {
    for (const kind of [
      "didnt_finish",
      "google_down",
      "no_refresh_token",
      "unconfirmed",
      "address_taken",
      "wrong_account",
      "changed",
      "client_refused",
      "removed_unconfirmed",
      "connected",
      "reconnected",
      "removed",
    ]) {
      await page.goto(`${origin}/?alert=${kind}`);
      const alert = page.getByRole("status");
      await alert.waitFor();
      expect(await alert.getAttribute("class"), kind).toContain(
        ["connected", "reconnected", "removed"].includes(kind) ? "bg-card" : "bg-warning",
      );
    }
    for (const outcome of ["not_found", "unavailable", "unknown"]) {
      await page.route("**/accounts/connect", (route) =>
        route.fulfill({ contentType: "application/json", body: JSON.stringify({ outcome }) }),
      );
      await page.goto(origin);
      await page.getByRole("button", { name: "Connect a Google account" }).click();
      const alert = page.getByRole("status");
      await alert.waitFor();
      expect(await alert.getAttribute("class"), outcome).toContain("bg-warning");
      await page.unroute("**/accounts/connect");
    }
  } finally {
    await page.close();
  }
}, 15000);

it("enables Connect again when Back restores the page from the browser cache", async () => {
  const page = await browser.newPage();
  try {
    await page.route("**/accounts/connect", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ outcome: "ok", url: "https://google.example/authorize" }),
      }),
    );
    await page.route("https://google.example/**", (route) => route.fulfill({ status: 204 }));
    await page.goto(origin);
    const connect = page.getByRole("button", { name: "Connect a Google account" });
    const navigation = page.waitForRequest("https://google.example/authorize");
    await connect.click();
    await navigation;
    expect(await connect.isDisabled()).toBe(true);
    await page.evaluate(() =>
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })),
    );
    await expect.poll(() => connect.isEnabled(), { timeout: 500 }).toBe(true);
  } finally {
    await page.close();
  }
});

it("uses the server's required Gmail permission count", async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`${origin}/?required=7`);
    const row = page.locator("tbody tr").filter({ hasText: "Research" });
    await row.waitFor();
    expect(await row.innerText()).toContain("Google granted 2 of the 7 permissions Gmail needs.");
  } finally {
    await page.close();
  }
});

it.each([390, 1280])(
  "reconnects the account chosen in the menu and restores controls after refusal at %s px",
  async (width) => {
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    try {
      await page.route("**/accounts/**", (route) =>
        route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({ outcome: "not_found" }),
        }),
      );
      for (const [name, id] of [
        ["Personal", "11111111-1111-4111-8111-111111111111"],
        ["Work", "33333333-3333-4333-8333-333333333333"],
      ]) {
        await page.goto(origin);
        const menu = page
          .getByRole("button", { name: `Actions for ${name}`, exact: true })
          .filter({ visible: true });
        await menu.click();
        const sent = page.waitForRequest((request) => request.method() === "POST");
        await page.getByRole("menuitem", { name: "Reconnect", exact: true }).click();
        expect(new URL((await sent).url()).pathname).toBe(`/accounts/${id}/reconnect`);
        await page.getByRole("status").waitFor();
        expect(await menu.isEnabled()).toBe(true);
        expect(
          await page.getByRole("button", { name: "Connect a Google account" }).isEnabled(),
        ).toBe(true);
      }
    } finally {
      await page.close();
    }
  },
);

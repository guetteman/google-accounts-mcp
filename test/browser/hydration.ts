import { mkdir } from "node:fs/promises";
import type { ApprovalPageProps } from "../../src/approvals/model";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { chromium } from "playwright-core";
import { build } from "vite-plus";

// Miniflare runs this test-only service in Node, where Chromium can load the Worker's HTML.
export async function hydrateAccounts(input: {
  url: string;
  html: string;
  headers: Record<string, string>;
  connection?: boolean;
  approval?: {
    action: "approve" | "reject";
    response: ApprovalPageProps;
    failure?: "lost" | "503";
  };
  width?: number;
  dark?: boolean;
  screenshot?: string;
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
    const page = await browser.newPage({
      viewport: { width: input.width ?? 1280, height: 900 },
      colorScheme: input.dark ? "dark" : "light",
    });
    page.setDefaultTimeout(2000);
    const errors: string[] = [];
    let clientLoads = 0;
    const submissions: Record<string, string>[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    page.on("pageerror", (error) => errors.push(error.message));
    let releaseDecision!: () => void;
    const decisionHeld = new Promise<void>((resolve) => {
      releaseDecision = resolve;
    });
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.href === input.url)
        return route.fulfill({ body: input.html, headers: input.headers });
      if (input.approval && url.pathname.endsWith(`/${input.approval.action}`)) {
        submissions.push(Object.fromEntries(new URLSearchParams(route.request().postData() ?? "")));
        await decisionHeld;
        if (input.approval.failure === "lost") return route.abort("failed");
        return route.fulfill({
          status: input.approval.failure === "503" ? 503 : 200,
          contentType: "application/json",
          body: JSON.stringify(
            input.approval.failure ? { outcome: "unknown" } : { approval: input.approval.response },
          ),
        });
      }
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
    if (input.dark) await page.locator("html").evaluate((el) => el.classList.add("dark"));
    if (input.approval) {
      await page.evaluate(() => document.fonts.ready);
      const before = await page.locator("main").boundingBox();
      const buttonsBefore = await page.getByRole("button").evaluateAll((buttons) =>
        buttons.map((button) => {
          const r = button.getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height };
        }),
      );
      await page
        .getByRole("button", {
          name: input.approval.action === "approve" ? "Approve" : "Reject",
          exact: true,
        })
        .click();
      const busyButton = page.getByRole("button", {
        name: input.approval.action === "approve" ? "Approving…" : "Reject",
        exact: true,
      });
      await busyButton.waitFor();
      const inFlight = {
        text: await page.locator("main").innerText(),
        busy: await busyButton.getAttribute("aria-busy"),
        spinner: await busyButton.locator("svg").count(),
        before,
        after: await page.locator("main").boundingBox(),
        buttonsBefore,
        buttonsAfter: await page.getByRole("button").evaluateAll((buttons) =>
          buttons.map((button) => {
            const r = button.getBoundingClientRect();
            return { x: r.x, y: r.y, width: r.width, height: r.height };
          }),
        ),
      };
      releaseDecision();
      if (input.approval.failure)
        await page.getByRole("link", { name: "Reload", exact: true }).waitFor();
      else if (input.approval.response.state.kind === "waiting")
        await page.getByText("Nothing ran. The request changed.", { exact: true }).waitFor();
      else
        await page
          .getByRole("heading", {
            level: 1,
            name:
              input.approval.response.state.kind === "rejected"
                ? "Rejected. Nothing ran."
                : "Approved. The call succeeded.",
            exact: true,
          })
          .waitFor();
      return {
        clientLoads,
        submissions,
        inFlight,
        heading: await page.getByRole("heading", { level: 1 }).innerText(),
        reload: await page.getByRole("link", { name: "Reload", exact: true }).count(),
        errors: errors.filter(
          (error) => !input.approval?.failure || !error.startsWith("Failed to load resource"),
        ),
      };
    }
    if (input.screenshot) {
      await page.evaluate(() => document.fonts.ready);
      await mkdir(".work/evidence", { recursive: true });
      await page.screenshot({ path: `.work/evidence/${input.screenshot}.png`, fullPage: true });
      return {
        clientLoads,
        overflow: await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        errors,
      };
    }
    if (input.connection) {
      const controls = page.getByRole("radiogroup");
      const before = await controls.evaluateAll((els) =>
        els.map((el) => ({
          name: el.getAttribute("aria-label"),
          selected: el.querySelector('[aria-checked="true"]')?.getAttribute("aria-label"),
        })),
      );
      let collapsed = false;
      try {
        await page.getByRole("button", { name: /Personal.*1 tool/ }).click();
        collapsed = !(await page
          .getByRole("radiogroup", { name: "List labels on Personal for Claude", exact: true })
          .isVisible());
      } catch (error) {
        errors.push(String(error));
      }
      return { clientLoads, controls: before, collapsed, errors };
    }
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

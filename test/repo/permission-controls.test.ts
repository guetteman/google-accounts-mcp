import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { chromium, type Browser, type Locator, type Page, type Route } from "playwright-core";
import { build } from "vite-plus";
import { afterAll, beforeAll, expect, it } from "vite-plus/test";

let browser: Browser;
let origin: string;
let server: ReturnType<typeof createServer>;
const endpoint = "/connections/11111111-1111-4111-8111-111111111111/permissions";
const unavailable = "Couldn't reach the database. Nothing changed. Try again in a minute.";
const unknown = "Couldn't confirm the change. Reload the page to see whether it happened.";

beforeAll(async () => {
  const bundle = await build({
    configFile: false,
    logLevel: "silent",
    plugins: [tailwindcss()],
    resolve: { alias: { "@": fileURLToPath(new URL("../../src", import.meta.url)) } },
    build: {
      write: false,
      minify: false,
      rollupOptions: {
        input: fileURLToPath(new URL("../browser/connection.tsx", import.meta.url)),
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
    if (path === "/") {
      response.setHeader("Content-Type", "text/html");
      response.end(html);
    } else if (assets.has(path)) {
      response.setHeader("Content-Type", path.endsWith(".css") ? "text/css" : "text/javascript");
      response.end(assets.get(path));
    } else response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch({ headless: true, channel: "chromium" });
}, 30_000);
afterAll(async () => {
  await browser?.close();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

const control = (page: Page, account = "Northwind") =>
  page.getByRole("radiogroup", { name: `List labels on ${account} for Claude`, exact: true });
const segment = (group: Locator, name: "Allowed" | "Not allowed") =>
  group.getByRole("radio", { name, exact: true });
async function selected(group: Locator, value: "Allowed" | "Not allowed" | null) {
  for (const name of ["Allowed", "Not allowed"] as const)
    expect(await segment(group, name).getAttribute("aria-checked")).toBe(String(value === name));
}
async function open(width = 1280) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  page.setDefaultTimeout(1500);
  await page.goto(origin);
  // Resolve the real component before testing interaction; never replace it with a fake.
  try {
    await expect
      .poll(() => page.getByRole("heading", { name: "Tool permissions", exact: true }).count(), {
        timeout: 1500,
        message: "the real ConnectionPage must render its permissions",
      })
      .toBe(1);
  } catch (error) {
    await page.close();
    throw error;
  }

  return page;
}
async function frames(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}
async function pending(page: Page) {
  const routes: Route[] = [];
  await page.route("**/connections/*/permissions", (route) => {
    routes.push(route);
  });
  return routes;
}
async function answer(route: Route, outcome: string) {
  await route.fulfill({ contentType: "application/json", body: JSON.stringify({ outcome }) });
}

it.each(["pointer", "Space", "Enter"])(
  "saves exactly one wanted permission with %s and confirms it only after ok",
  async (input) => {
    const page = await open();
    try {
      const routes = await pending(page);
      const group = control(page);
      const allowed = segment(group, "Allowed");
      await selected(group, "Not allowed");
      const opacity = await group.evaluate((el) => Number(getComputedStyle(el).opacity));
      const sent = page.waitForRequest((r) => r.method() === "POST");
      if (input === "pointer") await allowed.click();
      else {
        await allowed.focus();
        await page.keyboard.press(input);
      }
      const request = await sent;
      expect(new URL(request.url()).pathname).toBe(endpoint);
      expect(request.headers()["content-type"]).toContain("application/x-www-form-urlencoded");
      expect(Object.fromEntries(new URLSearchParams(request.postData()!))).toEqual({
        account: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        tool: "list_labels",
        allowed: "true",
      });
      expect(await group.getAttribute("aria-busy")).toBe("true");
      expect(await segment(group, "Allowed").getAttribute("aria-checked")).not.toBe("true");
      await expect
        .poll(() => group.evaluate((el) => Number(getComputedStyle(el).opacity)))
        .toBeLessThan(opacity);
      expect(await group.evaluate((el) => el.contains(document.activeElement))).toBe(true);
      await page.keyboard.press("Space");
      await page.keyboard.press("Enter");
      await segment(group, "Not allowed").click({ force: true });
      await frames(page);
      expect(routes).toHaveLength(1);
      await answer(routes[0]!, "ok");
      await expect.poll(() => segment(group, "Allowed").getAttribute("aria-checked")).toBe("true");
      await selected(group, "Allowed");
      expect(
        await page
          .getByText("Claude can see Personal and Northwind.", { exact: true })
          .filter({ visible: true })
          .count(),
      ).toBe(1);
      expect(await group.evaluate((el) => el.contains(document.activeElement))).toBe(true);
      const denied = page.waitForRequest((r) => r.method() === "POST");
      await segment(group, "Not allowed").click();
      expect(Object.fromEntries(new URLSearchParams((await denied).postData()!))).toEqual({
        account: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        tool: "list_labels",
        allowed: "false",
      });
      await answer(routes[1]!, "ok");
      await expect
        .poll(() => segment(group, "Not allowed").getAttribute("aria-checked"))
        .toBe("true");
    } finally {
      await page.close();
    }
  },
);

it("moves keyboard focus with arrows and Tab without changing a permission", async () => {
  const page = await open();
  try {
    const routes = await pending(page);
    const group = control(page);
    await segment(group, "Not allowed").focus();
    const initial = await page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
    await page.keyboard.press("ArrowLeft");
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.getAttribute("aria-label")))
      .not.toBe(initial);
    for (const key of ["ArrowRight", "ArrowUp", "ArrowDown", "Tab", "Shift+Tab"])
      await page.keyboard.press(key);
    await frames(page);
    expect(routes).toEqual([]);
    await selected(group, "Not allowed");
  } finally {
    await page.close();
  }
});

it.each([390, 1280])(
  "keeps every control in the same position through saving, success and failure at %s px",
  async (width) => {
    const page = await open(width);
    try {
      const routes = await pending(page);
      const boxes = () =>
        page.getByRole("radiogroup").evaluateAll((els) =>
          els.map((el) => {
            const r = el.getBoundingClientRect();
            return { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height };
          }),
        );
      const before = await boxes();
      expect(before).toHaveLength(4);
      for (const outcome of ["ok", "unavailable", "unknown"]) {
        const group = control(
          page,
          outcome === "ok"
            ? "Northwind"
            : outcome === "unavailable"
              ? "Projects"
              : "Fabrikam Holdings International, Finance and Legal Operations",
        );
        const sent = page.waitForRequest((r) => r.method() === "POST");
        await segment(group, "Allowed").click();
        await sent;
        await frames(page);
        expect(await boxes()).toEqual(before);
        await answer(routes.at(-1)!, outcome);
        await expect.poll(() => group.getAttribute("aria-busy")).not.toBe("true");
        await frames(page);
        expect(await boxes()).toEqual(before);
      }
    } finally {
      await page.close();
    }
  },
);

it.each(["unavailable", "503 HTML", "unknown", "lost response"])(
  "shows the correct stored-state certainty after %s and keeps its notice until dismissed",
  async (outcome) => {
    const page = await open(390);
    try {
      await page.clock.install();
      const routes = await pending(page);
      const group = control(page, "Personal");
      const sent = page.waitForRequest((r) => r.method() === "POST");
      await segment(group, "Not allowed").click();
      await sent;
      if (outcome === "lost response") await routes[0]!.abort("failed");
      else if (outcome === "503 HTML")
        await routes[0]!.fulfill({
          status: 503,
          contentType: "text/html",
          body: "<h1>Unavailable</h1>",
        });
      else await answer(routes[0]!, outcome);
      const known = ["unavailable", "503 HTML"].includes(outcome);
      const message = page
        .getByText(known ? unavailable : unknown, { exact: true })
        .filter({ visible: true });
      await message.first().waitFor();
      await selected(group, known ? "Allowed" : null);
      if (!known) {
        await segment(group, "Allowed").click({ force: true });
        await segment(group, "Not allowed").click({ force: true });
        await frames(page);
        expect(routes).toHaveLength(1);
        await selected(group, null);
      }
      await page.clock.fastForward(60_000);
      for (const position of [0, 100000]) {
        await page.evaluate((y) => window.scrollTo(0, y), position);
        await frames(page);
        const visible = await message.evaluateAll((els) =>
          els.some((el) => {
            const r = el.getBoundingClientRect();
            return r.top >= 0 && r.bottom <= innerHeight && r.width > 0;
          }),
        );
        expect(visible).toBe(true);
      }
      await page
        .getByRole("button", { name: "Dismiss", exact: true })
        .filter({ visible: true })
        .last()
        .click();
      expect(await message.count()).toBe(0);
      if (!known) await selected(group, null);
    } finally {
      await page.close();
    }
  },
);

it.each([
  ["already_ended", "Claude already ended. Nothing changed."],
  ["not_found", "This connection or account no longer exists. Nothing changed. Reload the page."],
  ["invalid", "Nothing changed. Reload the page."],
])("shows the exact permission message for %s", async (outcome, message) => {
  const page = await open();
  try {
    await page.route("**/connections/*/permissions", (route) => answer(route, outcome!));
    await segment(control(page), "Allowed").click();
    await page.getByText(message!, { exact: true }).filter({ visible: true }).first().waitFor();
    await selected(control(page), "Not allowed");
  } finally {
    await page.close();
  }
});

it("clears the previous failure notice when the owner makes the next change", async () => {
  const page = await open();
  try {
    const routes = await pending(page);
    const sent = page.waitForRequest((r) => r.method() === "POST");
    await segment(control(page), "Allowed").click();
    await sent;
    await answer(routes[0]!, "unavailable");
    await page.getByText(unavailable, { exact: true }).filter({ visible: true }).first().waitFor();
    await segment(control(page, "Projects"), "Allowed").click();
    expect(
      await page.getByText(unavailable, { exact: true }).filter({ visible: true }).count(),
    ).toBe(0);
    await answer(routes[1]!, "ok");
  } finally {
    await page.close();
  }
});

it("never changes permissions when clicking names, addresses, problem text or group headers", async () => {
  const page = await open();
  try {
    const routes = await pending(page);
    await page.getByText("alex@northwind.example", { exact: false }).click();
    await page
      .getByText("Google stopped accepting this server's access.", { exact: false })
      .click();
    const header = page.getByRole("button", { name: /Northwind.*1 tool/ });
    await header.click();
    expect(await control(page).isVisible()).toBe(false);
    await header.click();
    await selected(control(page), "Not allowed");
    await page.getByText("Projects", { exact: true }).filter({ visible: true }).click();
    await frames(page);
    expect(routes).toEqual([]);
    await selected(control(page, "Personal"), "Allowed");
  } finally {
    await page.close();
  }
});

it("names each permission and its state accessibly, provides tooltips and distinguishes segments by icon and fill", async () => {
  const page = await open();
  try {
    for (const account of [
      "Personal",
      "Northwind",
      "Projects",
      "Fabrikam Holdings International, Finance and Legal Operations",
    ]) {
      expect(await control(page, account).count()).toBe(1);
      await selected(control(page, account), account === "Personal" ? "Allowed" : "Not allowed");
    }
    const group = control(page, "Personal");
    await selected(group, "Allowed");
    const icons: string[] = [];
    const fills: string[] = [];
    for (const name of ["Allowed", "Not allowed"] as const) {
      const button = segment(group, name);
      icons.push(await button.locator("svg").innerHTML());
      fills.push(await button.evaluate((el) => getComputedStyle(el).backgroundColor));
      await button.hover();
      await page.getByRole("tooltip", { name, exact: true }).waitFor();
    }
    expect(icons[0]).not.toBe(icons[1]);
    expect(fills[0]).not.toBe(fills[1]);
    // Text is in the tooltip and accessible name, never repeated beside an open control.
    await page.mouse.move(0, 0);
    await page.keyboard.press("Escape");
    for (const word of ["Allowed", "Not allowed"])
      await expect
        .poll(() => page.getByText(word, { exact: true }).filter({ visible: true }).count())
        .toBe(0);
    const header = page.getByRole("button", { name: /Personal.*1 tool/ });
    await header.click();
    expect(await group.isVisible()).toBe(false);
    expect(await page.getByText("Allowed", { exact: true }).filter({ visible: true }).count()).toBe(
      1,
    );
  } finally {
    await page.close();
  }
});

it("accepts only one permission activation before React commits the saving state", async () => {
  const page = await open();
  try {
    const routes = await pending(page);
    const group = control(page);
    const sent = page.waitForRequest((r) => r.method() === "POST");
    await segment(group, "Allowed").evaluate((button) => {
      (button as HTMLButtonElement).click();
      (button as HTMLButtonElement).click();
    });
    await sent;
    await frames(page);
    expect(routes).toHaveLength(1);
    await answer(routes[0]!, "ok");
    await expect.poll(() => segment(group, "Allowed").getAttribute("aria-checked")).toBe("true");
  } finally {
    await page.close();
  }
});

it("exposes saving and unconfirmed controls as disabled to assistive technology", async () => {
  const page = await open();
  try {
    const routes = await pending(page);
    const group = control(page);
    const sent = page.waitForRequest((r) => r.method() === "POST");
    await segment(group, "Allowed").click();
    await sent;
    const disabled = async () => {
      expect(await group.getAttribute("aria-disabled")).toBe("true");
      for (const label of ["Allowed", "Not allowed"] as const)
        expect(await segment(group, label).getAttribute("aria-disabled")).toBe("true");
    };
    await disabled();
    await answer(routes[0]!, "unknown");
    await expect.poll(() => group.getAttribute("aria-busy")).toBe("false");
    await disabled();
  } finally {
    await page.close();
  }
});

it.each([
  ["unavailable", "ok", unavailable],
  ["unknown", "ok", unknown],
  ["unknown", "unavailable", unknown],
  ["unavailable", "already_ended", unavailable],
  ["unavailable", "not_found", unavailable],
  ["unavailable", "invalid", unavailable],
])(
  "keeps the %s notice when another save already in flight then answers %s",
  async (first, second, notice) => {
    const page = await open();
    try {
      const routes = await pending(page);
      for (const account of ["Northwind", "Projects"]) {
        const sent = page.waitForRequest((r) => r.method() === "POST");
        await segment(control(page, account), "Allowed").click();
        await sent;
      }
      await answer(routes[0]!, first!);
      const message = page.getByText(notice!, { exact: true }).filter({ visible: true });
      await message.waitFor();
      await answer(routes[1]!, second!);
      await expect.poll(() => control(page, "Projects").getAttribute("aria-busy")).not.toBe("true");
      await frames(page);
      expect(await message.count()).toBe(1);
    } finally {
      await page.close();
    }
  },
);

it("replaces a database notice with the unconfirmed notice when a save already in flight is unconfirmed", async () => {
  const page = await open();
  try {
    const routes = await pending(page);
    for (const account of ["Northwind", "Projects"]) {
      const sent = page.waitForRequest((r) => r.method() === "POST");
      await segment(control(page, account), "Allowed").click();
      await sent;
    }
    await answer(routes[0]!, "unavailable");
    await page.getByText(unavailable, { exact: true }).filter({ visible: true }).waitFor();
    await answer(routes[1]!, "unknown");
    await page.getByText(unknown, { exact: true }).filter({ visible: true }).waitFor();
    await frames(page);
    expect(await page.getByText(unavailable, { exact: true }).count()).toBe(0);
    await selected(control(page, "Projects"), null);
  } finally {
    await page.close();
  }
});

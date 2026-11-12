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
    const path = new URL(request.url!, "http://localhost").pathname;
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
const accountControl = (page: Page, account = "Northwind") =>
  page.getByRole("radiogroup", { name: `All tools on ${account} for Claude`, exact: true });
const searchControl = (page: Page, account = "Northwind") =>
  page.getByRole("radiogroup", { name: `Search mail on ${account} for Claude`, exact: true });
const panel = (page: Page, account = "Northwind") =>
  page
    .locator('[data-slot="collapsible"]')
    .filter({ has: page.getByRole("button", { name: account, exact: true }) });
const segment = (group: Locator, name: "Allowed" | "Not allowed" | "Ask first") =>
  group.getByRole("radio", { name, exact: true });
async function selected(group: Locator, value: "Allowed" | "Not allowed" | "Ask first" | null) {
  for (const name of ["Not allowed", "Ask first", "Allowed"] as const)
    expect(await segment(group, name).getAttribute("aria-checked")).toBe(String(value === name));
}
async function open(width = 1280, groups = false) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  page.setDefaultTimeout(1500);
  await page.goto(groups ? `${origin}/?groups` : origin);
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
        setting: "allow",
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
        setting: "deny",
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

it.each([390, 1280].flatMap((width) => ["tool", "account"].map((scope) => ({ width, scope }))))(
  "keeps every control in the same position through saving, success and failure for a $scope at $width px",
  async ({ width, scope }) => {
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
      expect(before).toHaveLength(12);
      for (const outcome of ["ok", "unavailable", "unknown"]) {
        const group = (scope === "tool" ? control : accountControl)(
          page,
          outcome === "ok"
            ? "Northwind"
            : outcome === "unavailable"
              ? "Projects"
              : "Fabrikam Holdings International, Finance and Legal Operations",
        );
        const sent = page.waitForRequest((r) => r.method() === "POST");
        await segment(group, "Allowed").click();
        if (scope === "account")
          await page.getByRole("button", { name: "Set to Allowed", exact: true }).click();
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
    const header = page.getByRole("button", { name: "Northwind", exact: true });
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
    for (const name of ["Not allowed", "Ask first", "Allowed"] as const) {
      const button = segment(group, name);
      icons.push(await button.locator("svg").innerHTML());
      fills.push(await button.evaluate((el) => getComputedStyle(el).backgroundColor));
      await button.hover();
      await page.getByRole("tooltip", { name, exact: true }).waitFor();
    }
    expect(new Set(icons).size).toBe(3);
    expect(fills[0]).not.toBe(fills[2]);
    // The tool controls stay icon-only; the account controls spell out the choices.
    await page.mouse.move(0, 0);
    await page.keyboard.press("Escape");
    for (const word of ["Not allowed", "Ask first", "Allowed"])
      await expect
        .poll(() => group.getByText(word, { exact: true }).filter({ visible: true }).count())
        .toBe(0);
    const header = page.getByRole("button", { name: "Personal", exact: true });
    await header.click();
    expect(await group.isVisible()).toBe(false);
    expect(await page.getByText("Allowed", { exact: true }).filter({ visible: true }).count()).toBe(
      4,
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
      for (const label of ["Not allowed", "Ask first", "Allowed"] as const)
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

it("offers least-to-most access and confirms Ask first only after the server saves it", async () => {
  const page = await open(390);
  try {
    const routes = await pending(page);
    const group = control(page);
    expect(
      await group
        .getByRole("radio")
        .evaluateAll((els) => els.map((el) => el.getAttribute("aria-label"))),
    ).toEqual(["Not allowed", "Ask first", "Allowed"]);
    const sent = page.waitForRequest((request) => request.method() === "POST");
    await segment(group, "Ask first").click();
    expect(Object.fromEntries(new URLSearchParams((await sent).postData()!))).toEqual({
      account: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      tool: "list_labels",
      setting: "ask",
    });
    await selected(group, "Not allowed");
    await answer(routes[0]!, "ok");
    await expect.poll(() => segment(group, "Ask first").getAttribute("aria-checked")).toBe("true");
    await selected(group, "Ask first");
    await page.getByRole("button", { name: "Northwind", exact: true }).click();
    expect(
      await page.getByText("Ask first", { exact: true }).filter({ visible: true }).count(),
    ).toBe(4);
    expect(
      await page
        .getByText(/sees an account once one of its tools is set to Ask first or Allowed/)
        .count(),
    ).toBe(1);
  } finally {
    await page.close();
  }
});

it("keeps the labelled account control in the header and derives its mixed counts from the tools", async () => {
  const page = await open();
  try {
    const personal = accountControl(page, "Personal");
    await selected(personal, null);
    expect(
      await panel(page, "Personal").getByText("1 allowed · 1 not allowed", { exact: true }).count(),
    ).toBe(1);
    await selected(accountControl(page), "Not allowed");
    expect(await page.getByText("Both tools", { exact: true }).count()).toBe(4);
    for (const label of ["Not allowed", "Ask first", "Allowed"] as const) {
      expect(await segment(personal, label).innerText()).toBe(label);
      expect(await segment(personal, label).locator("svg").count()).toBe(1);
    }
    await page.getByRole("button", { name: "Personal", exact: true }).click();
    expect(await personal.isVisible()).toBe(true);
    expect(await control(page, "Personal").isVisible()).toBe(false);
    expect(await panel(page, "Personal").locator("dl").count()).toBe(0);
    expect(await panel(page, "Personal").locator('[data-slot="badge"]').count()).toBe(0);
    expect(await panel(page, "Personal").getByText("Mixed", { exact: true }).count()).toBe(0);
  } finally {
    await page.close();
  }
});

it("denies every tool in one request without confirmation and skips the selected account value", async () => {
  const page = await open();
  try {
    const routes = await pending(page);
    await segment(accountControl(page), "Not allowed").click();
    await frames(page);
    expect(routes).toEqual([]);
    const sent = page.waitForRequest((request) => request.method() === "POST");
    await segment(accountControl(page, "Personal"), "Not allowed").click();
    const request = await sent;
    const form = new URLSearchParams(request.postData()!);
    expect(new URL(request.url()).pathname).toBe(endpoint);
    expect(form.get("account")).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    expect(form.get("setting")).toBe("deny");
    expect(form.getAll("tool")).toEqual(["list_labels", "search_threads"]);
    expect(await page.getByRole("alertdialog").count()).toBe(0);
    await answer(routes[0]!, "ok");
    await expect
      .poll(() =>
        segment(accountControl(page, "Personal"), "Not allowed").getAttribute("aria-checked"),
      )
      .toBe("true");
    await segment(accountControl(page, "Personal"), "Not allowed").click();
    await frames(page);
    expect(routes).toHaveLength(1);
  } finally {
    await page.close();
  }
});

it.each([
  {
    wanted: "Allowed" as const,
    setting: "allow",
    count: 1,
    text: "Claude will be able to use every tool on Personal without asking you. This changes 1 tool.",
  },
  {
    wanted: "Ask first" as const,
    setting: "ask",
    count: 2,
    text: "Claude will be able to call every tool on Personal, and each call will wait for your approval. This changes 2 tools.",
  },
])(
  "confirms $wanted with the changing count and returns focus after Cancel, Escape and confirmation",
  async ({ wanted, setting, text }) => {
    const page = await open(390);
    try {
      const routes = await pending(page);
      const opener = segment(accountControl(page, "Personal"), wanted);
      for (const close of ["Cancel", "Escape", "confirm"]) {
        await opener.click();
        const dialog = page.getByRole("alertdialog", {
          name: `Set all tools on Personal to ${wanted}?`,
          exact: true,
        });
        await dialog.waitFor();
        expect(await dialog.locator('[data-slot="alert-dialog-description"]').innerText()).toBe(
          text,
        );
        expect(await dialog.getByRole("button", { name: "Cancel", exact: true }).count()).toBe(1);
        expect(
          await dialog.getByRole("button", { name: `Set to ${wanted}`, exact: true }).count(),
        ).toBe(1);
        expect(routes).toEqual([]);
        if (close === "Escape") await page.keyboard.press("Escape");
        else if (close === "Cancel")
          await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
        else {
          const sent = page.waitForRequest((request) => request.method() === "POST");
          await dialog.getByRole("button", { name: `Set to ${wanted}`, exact: true }).click();
          const form = new URLSearchParams((await sent).postData()!);
          expect(form.getAll("tool")).toEqual(["list_labels", "search_threads"]);
          expect(form.get("setting")).toBe(setting);
          expect(routes).toHaveLength(1);
        }
        await expect.poll(() => page.getByRole("alertdialog").count()).toBe(0);
        await expect.poll(() => opener.evaluate((el) => el === document.activeElement)).toBe(true);
      }
      await answer(routes[0]!, "ok");
      await expect
        .poll(() => segment(accountControl(page, "Personal"), wanted).getAttribute("aria-checked"))
        .toBe("true");
      await expect
        .poll(async () => {
          const fill = (group: Locator) =>
            segment(group, wanted).evaluate((el) => getComputedStyle(el).backgroundColor);
          return (
            (await fill(accountControl(page, "Personal"))) ===
            (await fill(control(page, "Personal")))
          );
        })
        .toBe(true);
      await opener.click();
      await frames(page);
      expect(await page.getByRole("alertdialog").count()).toBe(0);
      expect(routes).toHaveLength(1);
    } finally {
      await page.close();
    }
  },
);

it("keeps all old values and blocks every account control until the batch succeeds", async () => {
  const page = await open();
  try {
    const routes = await pending(page);
    const sent = page.waitForRequest((request) => request.method() === "POST");
    await segment(accountControl(page), "Allowed").click();
    await page.getByRole("button", { name: "Set to Allowed", exact: true }).click();
    await sent;
    for (const group of [accountControl(page), control(page), searchControl(page)]) {
      await selected(group, "Not allowed");
      expect(await group.getAttribute("aria-busy")).toBe("true");
      expect(await group.getAttribute("aria-disabled")).toBe("true");
      await segment(group, "Ask first").click({ force: true });
    }
    expect(await panel(page).getByText("Saving…", { exact: true }).count()).toBe(1);
    await frames(page);
    expect(routes).toHaveLength(1);
    await answer(routes[0]!, "ok");
    await expect.poll(() => accountControl(page).getAttribute("aria-busy")).toBe("false");
    for (const group of [accountControl(page), control(page), searchControl(page)]) {
      await selected(group, "Allowed");
      expect(await group.getAttribute("aria-disabled")).toBe("false");
    }
    expect(
      await page
        .getByText("Claude can see Personal and Northwind.", { exact: true })
        .filter({ visible: true })
        .count(),
    ).toBe(1);
    expect(await panel(page).getByText("Saving…", { exact: true }).count()).toBe(0);
  } finally {
    await page.close();
  }
});

it.each(["unknown", "lost response"])(
  "leaves the entire account unconfirmed after %s and permits another account's change",
  async (outcome) => {
    const page = await open();
    try {
      const routes = await pending(page);
      const sent = page.waitForRequest((request) => request.method() === "POST");
      await segment(accountControl(page, "Personal"), "Not allowed").click();
      await sent;
      if (outcome === "unknown") await answer(routes[0]!, outcome);
      else await routes[0]!.abort("failed");
      await panel(page, "Personal").getByText("Unconfirmed", { exact: true }).waitFor();
      await page.getByText(unknown, { exact: true }).filter({ visible: true }).waitFor();
      for (const group of [
        accountControl(page, "Personal"),
        control(page, "Personal"),
        searchControl(page, "Personal"),
      ]) {
        await selected(group, null);
        expect(await group.getAttribute("aria-disabled")).toBe("true");
        await segment(group, "Allowed").click({ force: true });
      }
      await frames(page);
      expect(routes).toHaveLength(1);
      const next = page.waitForRequest((request) => request.method() === "POST");
      await segment(control(page), "Allowed").click();
      await next;
      await answer(routes[1]!, "ok");
      await expect
        .poll(() => segment(control(page), "Allowed").getAttribute("aria-checked"))
        .toBe("true");
    } finally {
      await page.close();
    }
  },
);

it.each([
  { outcome: "unavailable", message: unavailable },
  { outcome: "already_ended", message: "Claude already ended. Nothing changed." },
  {
    outcome: "not_found",
    message: "This connection or account no longer exists. Nothing changed. Reload the page.",
  },
  { outcome: "invalid", message: "Nothing changed. Reload the page." },
])(
  "restores each account value after $outcome and keeps the existing notice",
  async ({ outcome, message }) => {
    const page = await open();
    try {
      const routes = await pending(page);
      const sent = page.waitForRequest((request) => request.method() === "POST");
      await segment(accountControl(page, "Personal"), "Not allowed").click();
      await sent;
      await answer(routes[0]!, outcome);
      await page.getByText(message, { exact: true }).filter({ visible: true }).waitFor();
      await selected(accountControl(page, "Personal"), null);
      await selected(control(page, "Personal"), "Allowed");
      await selected(searchControl(page, "Personal"), "Not allowed");
      for (const group of [
        accountControl(page, "Personal"),
        control(page, "Personal"),
        searchControl(page, "Personal"),
      ])
        expect(await group.getAttribute("aria-disabled")).toBe("false");
    } finally {
      await page.close();
    }
  },
);

it("derives the account value from confirmed tools while one saves, then disables it after that answer is lost", async () => {
  const page = await open();
  try {
    const routes = await pending(page);
    const sent = page.waitForRequest((request) => request.method() === "POST");
    await segment(control(page), "Allowed").click();
    await sent;
    await selected(accountControl(page), "Not allowed");
    expect(await accountControl(page).getAttribute("aria-disabled")).toBe("true");
    expect(await accountControl(page).getAttribute("aria-busy")).toBe("false");
    expect(await panel(page).getByText("Saving…", { exact: true }).count()).toBe(0);
    await segment(accountControl(page), "Allowed").click({ force: true });
    expect(await page.getByRole("alertdialog").count()).toBe(0);
    await answer(routes[0]!, "unknown");
    await panel(page).getByText("Unconfirmed", { exact: true }).waitFor();
    await selected(accountControl(page), null);
    await selected(searchControl(page), "Not allowed");
    const next = page.waitForRequest((request) => request.method() === "POST");
    await segment(searchControl(page), "Allowed").click();
    await next;
    await answer(routes[1]!, "ok");
    await expect.poll(() => searchControl(page).getAttribute("aria-busy")).toBe("false");
    await selected(accountControl(page), null);
    expect(await accountControl(page).getAttribute("aria-disabled")).toBe("true");
    expect(await panel(page).getByText("Unconfirmed", { exact: true }).count()).toBe(1);
  } finally {
    await page.close();
  }
});

it("accepts only one account activation before React commits the saving state", async () => {
  const page = await open();
  try {
    const routes = await pending(page);
    const sent = page.waitForRequest((request) => request.method() === "POST");
    await segment(accountControl(page, "Personal"), "Not allowed").evaluate((button) => {
      (button as HTMLButtonElement).click();
      (button as HTMLButtonElement).click();
    });
    await sent;
    await frames(page);
    expect(routes).toHaveLength(1);
    await answer(routes[0]!, "ok");
  } finally {
    await page.close();
  }
});

it("orders groups once per account, preserves tool order and starts only the first account open with several groups", async () => {
  const page = await open(1280, true);
  try {
    const first = panel(page, "Personal");
    expect(await first.getByRole("heading", { level: 4 }).allTextContents()).toEqual([
      "Find and read",
      "Draft",
      "Send",
    ]);
    for (const [group, labels] of [
      ["Find and read", ["List labels", "Search mail"]],
      ["Draft", ["Create draft"]],
      ["Send", ["Send mail"]],
    ] as const) {
      const section = first.getByRole("group", { name: group, exact: true });
      expect(await section.locator('[data-slot="item-title"]').allTextContents()).toEqual(labels);
      expect(await section.getByRole("radiogroup").count()).toBe(labels.length);
    }
    expect(await page.getByText("All 4 tools", { exact: true }).count()).toBe(4);
    expect(await control(page, "Personal").isVisible()).toBe(true);
    for (const name of [
      "Northwind",
      "Projects",
      "Fabrikam Holdings International, Finance and Legal Operations",
    ]) {
      expect(
        await page.getByRole("button", { name, exact: true }).getAttribute("aria-expanded"),
      ).toBe("false");
      expect(await accountControl(page, name).isVisible()).toBe(true);
      expect(await control(page, name).isVisible()).toBe(false);
    }
    expect(await page.getByRole("heading", { level: 4 }).count()).toBe(3);
    await page.getByRole("button", { name: "Northwind", exact: true }).click();
    expect(await panel(page).getByRole("heading", { level: 4 }).allTextContents()).toEqual([
      "Find and read",
      "Draft",
      "Send",
    ]);
  } finally {
    await page.close();
  }
});

it("shows ordered group values or counts only for a closed mixed account, and removes them after a lost answer", async () => {
  const page = await open(390, true);
  try {
    const routes = await pending(page);
    expect(
      await panel(page)
        .getByText("1 allowed · 2 ask first · 1 not allowed", { exact: true })
        .count(),
    ).toBe(1);
    expect(await panel(page).locator("dl dt").allTextContents()).toEqual([
      "Find and read",
      "Draft",
      "Send",
    ]);
    expect(await panel(page).locator("dl dd").allTextContents()).toEqual([
      "1 allowed · 1 ask first",
      "Ask first",
      "Not allowed",
    ]);
    expect(await panel(page, "Projects").locator("dl").count()).toBe(0);
    expect(await panel(page).getByText("Mixed", { exact: true }).count()).toBe(0);
    expect(await panel(page).locator('[data-slot="badge"]').count()).toBe(0);
    const sent = page.waitForRequest((request) => request.method() === "POST");
    await segment(accountControl(page), "Not allowed").click();
    const form = new URLSearchParams((await sent).postData()!);
    expect(form.getAll("tool")).toEqual(["send", "list_labels", "draft", "search_threads"]);
    await answer(routes[0]!, "unknown");
    await panel(page).getByText("Unconfirmed", { exact: true }).waitFor();
    expect(await panel(page).locator("dl").count()).toBe(0);
    await selected(accountControl(page), null);
  } finally {
    await page.close();
  }
});

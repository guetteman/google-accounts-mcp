import { env } from "cloudflare:workers";
import { expect, it } from "vite-plus/test";
import "./support/account-checks";
import type { TestEnv } from "./env";
import { ownerBrowser, seedAccount, start, NOW } from "./support/accounts";
import { google } from "./support/google";
import { ORIGIN } from "./support/worker";

it("keeps both accounts and the alert after the real client hydrates the server page", async () => {
  const personal = await seedAccount({ name: "Personal", sub: "personal" });
  await seedAccount({
    name: "Work",
    email: "alex@harbor.example",
    sub: "work",
    hd: "harbor.example",
    created_at: NOW + 1,
  });
  const owner = await ownerBrowser();
  const { url } = await start(owner, personal.id);
  expect((await owner.get(google.issueCode(url, { claims: { sub: personal.sub } }))).status).toBe(
    303,
  );
  const response = await owner.get("/accounts");
  expect(response.status).toBe(200);
  const hydrated = await (
    await (env as TestEnv).TEST_BROWSER.fetch("http://browser/hydrate", {
      method: "POST",
      body: JSON.stringify({
        url: `${ORIGIN}/accounts`,
        html: await response.text(),
        headers: Object.fromEntries(response.headers),
      }),
    })
  ).json<{ clientLoads: number; rows: string[]; alerts: string[]; errors: string[] }>();
  expect(hydrated.errors).toEqual([]);
  expect(hydrated.clientLoads).toBe(1);
  expect(hydrated.rows).toHaveLength(2);
  expect(hydrated.rows[0]).toContain("Personal");
  expect(hydrated.rows[0]).toContain("alex.personal@example.com");
  expect(hydrated.rows[1]).toContain("Work");
  expect(hydrated.rows[1]).toContain("alex@harbor.example");
  expect(hydrated.alerts).toEqual([
    "Reconnected alex.personal@example.com. Every connection keeps the permissions it had for this account.",
  ]);
}, 30_000);

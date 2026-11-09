import { env } from "cloudflare:workers";
import { expect, it } from "vite-plus/test";
import "./support/account-checks";
import { accounts, finish, ownerBrowser, seedAccount, start } from "./support/accounts";
import { SCOPES } from "./support/google";

it("retains every Google scope while counting only Gmail permissions", async () => {
  const granted = [
    "openid",
    "email",
    SCOPES[0]!,
    "https://www.googleapis.com/auth/calendar.readonly",
  ];
  const b = await ownerBrowser();
  const result = await finish(b, (await start(b)).url, { scope: granted.join(" ") });
  expect(JSON.parse((await accounts())[0]!.scopes)).toEqual(granted);
  expect(result.text).toContain("Google granted 1 of the 5 permissions Gmail needs.");
});

it("rejects the wrong SQLite storage type without changing the account", async () => {
  const row = await seedAccount();
  await expect(
    env.DB.prepare("UPDATE accounts SET created_at = 'not-a-timestamp' WHERE id = ?")
      .bind(row.id)
      .run(),
  ).rejects.toThrow();
  expect(await accounts()).toEqual([row]);
});

import { readFile } from "node:fs/promises";
import { expect, it } from "vite-plus/test";

it("schedules approval cleanup every ten minutes", async () => {
  const config = await readFile("wrangler.jsonc", "utf8");
  expect(config).toMatch(/"crons":\s*\["\*\/10 \* \* \* \*"\]/);
});

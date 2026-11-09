import { expect, it } from "vite-plus/test";
import { Result } from "effect";
import { readConfig } from "../src/config";
import { open, seal, type Sealed } from "../src/seal";
import { fixtureOpen } from "./support/accounts";
import { testEnv } from "./support/worker";

const config = readConfig(testEnv());
if (Result.isFailure(config)) throw new Error("Invalid encryption test configuration");
const key = config.success.tokenKey;

it("uses distinct nonces for repeated encryption of the same plaintext", async () => {
  const context = "11111111-1111-4111-8111-111111111111:refresh";
  const first = await seal(key, context, "synthetic secret");
  const second = await seal(key, context, "synthetic secret");
  expect(first.split(".")[2]).not.toBe(second.split(".")[2]);
  expect(await fixtureOpen(context, first)).toBe("synthetic secret");
  expect(await fixtureOpen(context, second)).toBe("synthetic secret");
});

it("refuses a changed key ID even when the nonce and ciphertext are intact", async () => {
  const context = "11111111-1111-4111-8111-111111111111:refresh";
  const sealed = await seal(key, context, "synthetic secret");
  const parts = sealed.split(".");
  parts[1] = parts[1] === "0000000000000000" ? "1111111111111111" : "0000000000000000";
  expect(await open(key, context, parts.join(".") as Sealed)).toBeNull();
  expect(await open(key, context, sealed)).toBe("synthetic secret");
});

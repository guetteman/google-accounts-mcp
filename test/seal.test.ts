import { expect, it } from "vite-plus/test";
import { Result } from "effect";
import { readConfig } from "../src/config";
import { open, seal, type Sealed } from "../src/seal";
import { fixtureOpen, fixtureSeal } from "./support/accounts";
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
  expect(await open(key, context, parts.join(".") as Sealed)).toEqual({
    ok: false,
    reason: "other_key",
  });
  expect(await open(key, context, sealed)).toEqual({ ok: true, value: "synthetic secret" });
});

it("preserves ciphertext when key import fails and recovers after the local failure", async () => {
  const { vi } = await import("vite-plus/test");
  const context = "11111111-1111-4111-8111-111111111111:refresh";
  const uniqueKey = crypto.getRandomValues(new Uint8Array(32)) as import("../src/config").TokenKey;
  const sealed = (await fixtureSeal(context, "synthetic secret", uniqueKey)) as Sealed;
  const failure = vi
    .spyOn(crypto.subtle, "importKey")
    .mockRejectedValue(new Error("local key service failed"));
  expect(await open(uniqueKey, context, sealed)).toEqual({ ok: false, reason: "unavailable" });
  failure.mockRestore();
  expect(await open(uniqueKey, context, sealed)).toEqual({
    ok: true,
    value: "synthetic secret",
  });
});

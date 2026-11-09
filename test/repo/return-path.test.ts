import { expect, it } from "vite-plus/test";
import { returnPath } from "../../src/http/return-path";

it.each(["/safe/..//evil.example/", "/safe/%2e%2e//evil.example/"])(
  "refuses %s when URL normalization would turn it into a protocol-relative redirect",
  (raw) => {
    expect(returnPath(raw, "https://accounts-mcp.example.com")).toBe("/accounts");
  },
);

it("falls back to /accounts for a path too long to fit in the sign-in's state cookie", () => {
  expect(returnPath(`/accounts?x=${"a".repeat(1100)}`, "https://accounts-mcp.example.com")).toBe(
    "/accounts",
  );
  expect(returnPath(`/accounts?x=${"a".repeat(900)}`, "https://accounts-mcp.example.com")).toBe(
    `/accounts?x=${"a".repeat(900)}`,
  );
});

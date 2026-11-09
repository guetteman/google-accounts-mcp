import { expect, it } from "vite-plus/test";
import { returnPath } from "../../src/http/return-path";

it.each(["/safe/..//evil.example/", "/safe/%2e%2e//evil.example/"])(
  "refuses %s when URL normalization would turn it into a protocol-relative redirect",
  (raw) => {
    expect(returnPath(raw, "https://accounts-mcp.example.com")).toBe("/accounts");
  },
);

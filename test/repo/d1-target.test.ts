import { describe, expect, it } from "vite-plus/test";
import { databaseLabel, ownerDatabase } from "../../scripts/d1-target.ts";

const NAME_ONLY = { binding: "DB", database_name: "owner-storage" };
const BOTH = { ...NAME_ONLY, database_id: "00000000-0000-4000-8000-0000000000aa" };
const WITH_PREVIEW = { ...BOTH, preview_database_id: "00000000-0000-4000-8000-0000000000bb" };

describe("the database the reset names before it asks", () => {
  it("is the ID wrangler uses remotely, even when a name is also configured", () => {
    expect(databaseLabel("accounts", BOTH, "remote")).toBe(
      "owner-storage, id 00000000-0000-4000-8000-0000000000aa (remote)",
    );
  });

  it("is the preview ID wrangler keys local state by, when one is configured", () => {
    expect(databaseLabel("accounts", WITH_PREVIEW, "local")).toBe(
      "owner-storage, id 00000000-0000-4000-8000-0000000000bb (local)",
    );
    expect(databaseLabel("accounts", WITH_PREVIEW, "remote")).toContain("0000000000aa");
  });

  it("is the configured name, or the name wrangler gives a database it provisioned", () => {
    expect(databaseLabel("accounts", NAME_ONLY, "remote")).toBe("owner-storage (remote)");
    expect(databaseLabel("accounts", NAME_ONLY, "local")).toBe("owner-storage (local)");
    expect(databaseLabel("google-accounts-mcp", { binding: "DB" }, "local")).toBe(
      "google-accounts-mcp-db (local)",
    );
    expect(databaseLabel("w", { binding: "MY_DB" }, "remote")).toBe("w-my-db (remote)");
  });
});

describe("the configuration's DB database", () => {
  const other = {
    binding: "OTHER",
    database_name: "DB",
    database_id: "00000000-0000-4000-8000-0000000000cc",
  };

  it("is the DB binding when nothing else is named DB", () => {
    expect(ownerDatabase([{ binding: "CACHE" }, BOTH])).toBe(BOTH);
  });

  it("is refused when another database is named DB, before or after the binding", () => {
    expect(() => ownerDatabase([other, BOTH])).toThrow();
    expect(() => ownerDatabase([BOTH, other])).toThrow();
  });

  it("is refused when the configuration has no DB binding", () => {
    expect(() => ownerDatabase([{ binding: "CACHE" }])).toThrow();
    expect(() => ownerDatabase([])).toThrow();
  });
});

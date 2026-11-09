import { describe, expect, it } from "vite-plus/test";
import { databaseLabel } from "../../scripts/d1-target.ts";

const NAME_ONLY = { binding: "DB", database_name: "accounts-db" };
const BOTH = { ...NAME_ONLY, database_id: "00000000-0000-4000-8000-0000000000aa" };
const WITH_PREVIEW = { ...BOTH, preview_database_id: "00000000-0000-4000-8000-0000000000bb" };

describe("the database the reset names before it asks", () => {
  it("is the ID wrangler uses remotely, even when a name is also configured", () => {
    expect(databaseLabel("accounts", BOTH, "remote")).toBe(
      "accounts-db, id 00000000-0000-4000-8000-0000000000aa (remote)",
    );
  });

  it("is the preview ID wrangler keys local state by, when one is configured", () => {
    expect(databaseLabel("accounts", WITH_PREVIEW, "local")).toBe(
      "accounts-db, id 00000000-0000-4000-8000-0000000000bb (local)",
    );
    expect(databaseLabel("accounts", WITH_PREVIEW, "remote")).toContain("0000000000aa");
  });

  it("is the configured name, or the name wrangler gives a database it provisioned", () => {
    expect(databaseLabel("accounts", NAME_ONLY, "remote")).toBe("accounts-db (remote)");
    expect(databaseLabel("google-accounts-mcp", { binding: "DB" }, "local")).toBe(
      "google-accounts-mcp-db (local)",
    );
    expect(databaseLabel("w", { binding: "MY_DB" }, "remote")).toBe("w-my-db (remote)");
  });
});

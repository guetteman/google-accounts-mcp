import { describe, expect, it } from "vite-plus/test";
import {
  databaseLabel,
  expectedTargetId,
  ownerDatabase,
  sameTarget,
  targetMatches,
  wranglerTarget,
} from "../../scripts/d1-target.ts";

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
    expect(() => ownerDatabase([other])).toThrow();
    expect(() => ownerDatabase([])).toThrow();
  });
});

describe("the database wrangler says it used", () => {
  it("is read from the line wrangler prints before it runs SQL", () => {
    expect(
      wranglerTarget("🌀 Executing on local database DB (DB) from .wrangler/state/v3/d1:\n[]"),
    ).toEqual({ mode: "local", id: "DB", path: ".wrangler/state/v3/d1" });
    expect(
      wranglerTarget(
        "🌀 Executing on remote database DB (00000000-0000-4000-8000-0000000000aa):\n[]",
      ),
    ).toEqual({ mode: "remote", id: "00000000-0000-4000-8000-0000000000aa" });
    expect(wranglerTarget("[]")).toBeNull();
  });

  it("must match the configured database: its local key, or its remote ID when it has one", () => {
    expect(expectedTargetId(WITH_PREVIEW, "local")).toBe("00000000-0000-4000-8000-0000000000bb");
    expect(expectedTargetId(BOTH, "local")).toBe("00000000-0000-4000-8000-0000000000aa");
    expect(expectedTargetId(NAME_ONLY, "local")).toBe("DB");
    expect(expectedTargetId(WITH_PREVIEW, "remote")).toBe("00000000-0000-4000-8000-0000000000aa");
    expect(expectedTargetId(NAME_ONLY, "remote")).toBeUndefined();
  });
});

describe("whether wrangler used the configured database", () => {
  const AA = "00000000-0000-4000-8000-0000000000aa";

  it("reads where local state lives, so two local runs can be compared", () => {
    const one = wranglerTarget(
      "🌀 Executing on local database DB (DB) from .wrangler/state/v3/d1:",
    );
    const two = wranglerTarget("🌀 Executing on local database DB (DB) from other/v3/d1:");
    expect(one).toEqual({ mode: "local", id: "DB", path: ".wrangler/state/v3/d1" });
    expect(one && two && sameTarget(one, two)).toBe(false);
    expect(one && sameTarget(one, { ...one })).toBe(true);
  });

  it("refuses a target in the other mode", () => {
    expect(targetMatches({ mode: "remote", id: "DB" }, NAME_ONLY, "local")).toBe(false);
    expect(targetMatches({ mode: "local", id: AA }, BOTH, "remote")).toBe(false);
  });

  it("accepts wrangler's preview label on the remote database_id, and nothing else", () => {
    expect(targetMatches({ mode: "preview", id: AA }, WITH_PREVIEW, "remote")).toBe(true);
    expect(
      targetMatches(
        { mode: "preview", id: "00000000-0000-4000-8000-0000000000bb" },
        WITH_PREVIEW,
        "remote",
      ),
    ).toBe(false);
  });

  it("refuses another ID, and accepts any UUID only when the configuration has none", () => {
    expect(targetMatches({ mode: "local", id: AA }, WITH_PREVIEW, "local")).toBe(false);
    expect(targetMatches({ mode: "remote", id: "x" }, BOTH, "remote")).toBe(false);
    expect(targetMatches({ mode: "remote", id: "x" }, NAME_ONLY, "remote")).toBe(true);
  });
});

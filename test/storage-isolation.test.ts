import { NOW } from "./support/accounts";
import { google } from "./support/google";
import { network } from "./support/network";
import { attaching, upload, attachCall } from "./support/uploads";
import { expectError } from "./support/permissions";
import { abortAllDurableObjects } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { resetBindings } from "./support/reset";

it("resets D1 and KV whose instances have been evicted, including the migration state", async () => {
  await env.DB.prepare("CREATE TABLE isolation_probe (value TEXT)").run();
  await env.DB.prepare("INSERT INTO isolation_probe VALUES ('old state')").run();
  await env.DB.prepare(
    "UPDATE owner SET state = 'pinned', email = 'old@example.com' WHERE id = 1",
  ).run();
  await env.OAUTH_KV.put("isolation-probe", "old state");
  // Keep the backing storage but remove its live instances, as idle eviction does.
  await abortAllDurableObjects();
  await resetBindings();
  const table = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE name = 'isolation_probe'",
  ).first();
  expect(table).toBeNull();
  expect(await env.OAUTH_KV.get("isolation-probe")).toBeNull();
  expect(await env.DB.prepare("SELECT state FROM owner WHERE id = 1").first()).toEqual({
    state: "unpinned",
  });
});

describe("file storage isolation after eviction", { concurrent: false, shuffle: false }, () => {
  it("stores file bytes and evicts the KV instance before the next test", async () => {
    const bytes = new Uint8Array([0, 255, 254, 1]);
    await env.FILES_KV.put("file:isolation-probe", bytes.buffer);
    expect(await env.FILES_KV.get("file:isolation-probe", "arrayBuffer")).toEqual(bytes.buffer);
    await abortAllDurableObjects();
  });

  it("does not retain the file stored by the previous test", async () => {
    expect(await env.FILES_KV.get("file:isolation-probe", "arrayBuffer")).toBeNull();
  });
});

describe("upload storage isolation after eviction", { concurrent: false, shuffle: false }, () => {
  let uploadId: string;
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    google.reset();
    network.use(...google.handlers());
  });
  it("leaves an unused uploaded file before evicting storage", async () => {
    const f = await attaching();
    uploadId = (await upload(f)).upload;
    expect((await env.DB.prepare("SELECT id FROM uploads").all()).results).toHaveLength(1);
    expect((await env.FILES_KV.list()).keys).toHaveLength(1);
    await abortAllDurableObjects();
  });
  it("retains neither the upload row nor its bytes in the next test", async () => {
    expect((await env.DB.prepare("SELECT * FROM uploads").all()).results).toEqual([]);
    expect((await env.FILES_KV.list()).keys).toEqual([]);
    const f = await attaching();
    await expectError(
      await attachCall(f, [{ upload: uploadId }]),
      "upload_not_available",
      `No upload "${uploadId}" is available to this connection. An upload works once, in the connection that asked for its link, before it expires. Call create_upload_link and send the file again.`,
    );
  });
});

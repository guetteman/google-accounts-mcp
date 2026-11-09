import { cloudflare } from "@cloudflare/vite-plugin";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import tailwindcss from "@tailwindcss/vite";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";

const isTest = process.env.VITEST !== undefined;
const testMigrations = isTest ? await readD1Migrations("migrations") : [];
const alias = { "@": fileURLToPath(new URL("./src", import.meta.url)) };

// Throwaway configuration for the tests, made fresh on every run, so no test holds a real value.
// The owner's address is a reserved example address.
const testConfig = {
  OWNER_EMAIL: "alex.personal@example.com",
  GOOGLE_CLIENT_ID: "test-client-id.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: `test-${randomBytes(16).toString("hex")}`,
};

export default defineConfig({
  server: { host: true },
  plugins: isTest ? [] : [tailwindcss(), cloudflare()],
  resolve: { alias },
  build: {
    rollupOptions: {
      // Radix and lucide ship "use client" directives, which mean nothing in these bundles.
      onwarn(warning, warn) {
        if (warning.code !== "MODULE_LEVEL_DIRECTIVE") warn(warning);
      },
    },
  },
  environments: {
    // The browser bundle and the stylesheet keep fixed names, so the Worker links them without a
    // manifest. Workers Static Assets revalidates them by ETag on every load.
    client: {
      build: {
        rollupOptions: {
          input: ["src/pages/client.tsx", "src/styles.css"],
          output: { entryFileNames: "assets/[name].js", assetFileNames: "assets/[name][extname]" },
        },
      },
    },
  },
  test: {
    projects: isTest
      ? [
          {
            plugins: [
              tailwindcss(),
              cloudflareTest({
                wrangler: { configPath: "./wrangler.jsonc" },
                miniflare: { bindings: { ...testConfig, TEST_MIGRATIONS: testMigrations } },
              }),
            ],
            resolve: { alias },
            test: {
              name: "worker",
              include: ["test/*.test.ts"],
              setupFiles: ["./test/setup.ts"],
              // When a pool slot runs a second file, Vitest answers its fetchWarmModules call
              // with paths into this cache, and @cloudflare/vitest-plugin inlines every module
              // into one WebSocket message. On few cores that message outgrows workerd's limit
              // (close 1009) and kills the run. Without the cache, modules travel one per message.
              fsModuleCache: false,
            },
          },
          {
            test: { name: "repo", environment: "node", include: ["test/repo/*.test.ts"] },
          },
        ]
      : undefined,
  },
  lint: {
    options: { typeAware: true, typeCheck: true },
    ignorePatterns: ["worker-configuration.d.ts", "dist/**"],
  },
  fmt: {
    ignorePatterns: ["worker-configuration.d.ts", "dist/**"],
  },
});

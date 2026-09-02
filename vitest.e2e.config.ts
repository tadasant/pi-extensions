import { defineConfig } from "vitest/config";

/**
 * End-to-end tests: each one spawns the real, pinned Pi CLI against a simulated
 * LLM API on localhost. They are slower and share a downloaded Pi install, so they
 * run in a single fork with a generous timeout.
 */
export default defineConfig({
  test: {
    include: ["e2e/tests/**/*.e2e.test.ts"],
    environment: "node",
    globalSetup: ["e2e/harness/global-setup.ts"],
    testTimeout: 120_000,
    hookTimeout: 300_000,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
});

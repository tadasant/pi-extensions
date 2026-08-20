import { defineConfig } from "vitest/config";

/** Unit tests: pure logic, no Pi binary, no network. */
export default defineConfig({
  test: {
    include: ["packages/**/test/**/*.test.ts"],
    environment: "node",
    testTimeout: 15_000,
  },
});

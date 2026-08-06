import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Conformance tests hit a real instance over the network; generous
    // timeouts beat flaky failures on slow PoW solves or cold instances.
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // Serial files: tests share an instance and some assert on cross-client
    // effects; parallel files would race on rate limits and fixtures.
    fileParallelism: false,
  },
});

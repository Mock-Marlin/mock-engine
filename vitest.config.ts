/**
 * Copyright (c) 2026 MockMarlin
 *
 * SPDX-License-Identifier: MIT
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    fileParallelism: false,
    testTimeout: 10_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/cli.ts",
        "src/admin-cli.ts",
        "src/redis-store.ts",
        "src/import/har.ts",
        "src/import/openapi.ts",
        "src/import/parse-file.ts",
        "src/import/postman.ts",
      ],
      thresholds: {
        lines: 95,
        statements: 95,
        functions: 95,
        branches: 90,
      },
    },
  },
});

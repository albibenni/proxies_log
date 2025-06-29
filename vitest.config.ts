/// <reference types="vitest" />
import { defineConfig } from "vitest/config";
import { config } from "dotenv";

export default defineConfig({
  test: {
    // globalSetup: "./src/__tests__/global.setup.ts",
    passWithNoTests: true,
    globals: true,
    fileParallelism: false,
    poolOptions: {
      maxWorkers: 1,
    },
    setupFiles: ["dotenv/config"],
    env: {
      ...config({ path: "./.env.local" }).parsed,
    },
    root: "./src",
  },
});

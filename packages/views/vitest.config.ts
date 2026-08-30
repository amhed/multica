import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Date assertions in this suite are written against UTC; without this they
// drift by a day on machines west of Greenwich (billing-tab renders
// "2030-02-01T00:00:00Z" as Jan 31 in UTC-4).
process.env.TZ = "UTC";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./test/setup.ts"],
    include: ["**/*.test.{ts,tsx}"],
  },
});

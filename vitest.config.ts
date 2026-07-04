import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    env: {
      DATABASE_URL: "postgres://postgres:postgres@localhost:5432/realtor_test",
      APP_BASE_URL: "https://agent.test",
      ADMIN_USER: "test",
      ADMIN_PASSWORD: "test",
      APPROVAL_TOKEN_SECRET: "test-secret-test-secret",
      REALTOR_NAME: "Ray",
      TZ: "America/Toronto",
    },
  },
});

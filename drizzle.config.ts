import type { Config } from "drizzle-kit";

export default {
  schema: "./worker/db/schema.ts",
  out: "./migrations",
  dialect: "sqlite",
  driver: "d1-http",
} satisfies Config;

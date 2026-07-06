import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema.js";
import { config } from "../config.js";

export type Db = ReturnType<typeof drizzle<typeof schema>>;

let pool: pg.Pool | undefined;
let dbInstance: Db | undefined;

export function db(): Db {
  if (!dbInstance) {
    pool = new pg.Pool({ connectionString: config().DATABASE_URL, max: 10 });
    dbInstance = drizzle(pool, { schema });
  }
  return dbInstance;
}

export function pgPool(): pg.Pool {
  db();
  return pool!;
}

export async function closeDb(): Promise<void> {
  await pool?.end();
  pool = undefined;
  dbInstance = undefined;
}

export { schema };

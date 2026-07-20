import { Pool } from "pg";

const globalForPg = globalThis as unknown as { pgPool: Pool };

export const pool: Pool =
  globalForPg.pgPool ??
  new Pool({ connectionString: process.env.DATABASE_URL });

if (process.env.NODE_ENV !== "production") globalForPg.pgPool = pool;

export async function query<T = Record<string, unknown>>(
  sql: string,
  params?: unknown[],
): Promise<T[]> {
  const { rows } = await pool.query<T>(sql, params);
  return rows;
}

export async function execute(sql: string, params?: unknown[]): Promise<void> {
  await pool.query(sql, params);
}

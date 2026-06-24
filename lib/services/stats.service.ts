import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { mapDbError } from "@/lib/errors";

export interface SeedStats {
  customers: number;
  products: number;
}

export async function getSeedStats(): Promise<SeedStats> {
  try {
    const rows = await prisma.$queryRaw<{ customers: bigint; products: bigint }[]>(Prisma.sql`
      SELECT
        (SELECT count(*) FROM customers) AS customers,
        (SELECT count(*) FROM products)  AS products`);
    const row = rows[0];
    return {
      customers: Number(row.customers),
      products: Number(row.products),
    };
  } catch (err) {
    mapDbError(err, "getSeedStats");
  }
}

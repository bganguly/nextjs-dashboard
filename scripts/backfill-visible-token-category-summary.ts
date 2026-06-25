/**
 * Backfills token/category chart summaries for every visible customer name token
 * in small transactions. This supports fast q=<name> plus status/region slices.
 *
 * Run:
 *   npx tsx scripts/backfill-visible-token-category-summary.ts
 */

import { Prisma, PrismaClient } from "@prisma/client";

const prisma = new PrismaClient({ log: ["error", "warn"] });

async function visibleNameTokens(): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ token: string }[]>(Prisma.sql`
    SELECT DISTINCT token
    FROM (
      SELECT lower("firstName") AS token FROM customers
      UNION
      SELECT lower("lastName") AS token FROM customers
    ) t
    WHERE token <> ''
    ORDER BY token`);
  return rows.map((r) => r.token);
}

async function backfillToken(token: string): Promise<void> {
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO "daily_customer_token_category_summary" (
      "date",
      "token",
      "regionId",
      "regionCode",
      "status",
      "categoryId",
      "categoryName",
      "totalOrders",
      "totalRevenue",
      "totalItems",
      "createdAt",
      "updatedAt"
    )
    SELECT
      ds."date",
      ${token},
      ds."regionId",
      ds."regionCode",
      ds."status",
      ds."categoryId",
      ds."categoryName",
      SUM(ds."totalOrders")::integer,
      SUM(ds."totalRevenue"),
      SUM(ds."totalItems")::integer,
      now(),
      now()
    FROM "daily_customer_category_summary" ds
    JOIN customers c ON c.id = ds."customerId"
    WHERE lower(c."firstName") = ${token}
       OR lower(c."lastName") = ${token}
    GROUP BY
      ds."date",
      ds."regionId",
      ds."regionCode",
      ds."status",
      ds."categoryId",
      ds."categoryName"
    ON CONFLICT ("date", "token", "regionId", "status", "categoryId") DO UPDATE SET
      "regionCode" = EXCLUDED."regionCode",
      "categoryName" = EXCLUDED."categoryName",
      "totalOrders" = EXCLUDED."totalOrders",
      "totalRevenue" = EXCLUDED."totalRevenue",
      "totalItems" = EXCLUDED."totalItems",
      "updatedAt" = now()`);

  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO "daily_customer_token_category_rollup" (
      "date",
      "token",
      "categoryId",
      "categoryName",
      "totalOrders",
      "totalRevenue",
      "totalItems",
      "createdAt",
      "updatedAt"
    )
    SELECT
      "date",
      "token",
      "categoryId",
      "categoryName",
      SUM("totalOrders")::integer,
      SUM("totalRevenue"),
      SUM("totalItems")::integer,
      now(),
      now()
    FROM "daily_customer_token_category_summary"
    WHERE token = ${token}
    GROUP BY "date", "token", "categoryId", "categoryName"
    ON CONFLICT ("date", "token", "categoryId") DO UPDATE SET
      "categoryName" = EXCLUDED."categoryName",
      "totalOrders" = EXCLUDED."totalOrders",
      "totalRevenue" = EXCLUDED."totalRevenue",
      "totalItems" = EXCLUDED."totalItems",
      "updatedAt" = now()`);
}

async function main() {
  const tokens = await visibleNameTokens();
  console.log(`Backfilling ${tokens.length} visible name token(s): ${tokens.join(", ")}`);

  for (const [i, token] of tokens.entries()) {
    const started = Date.now();
    await backfillToken(token);
    console.log(
      `[${i + 1}/${tokens.length}] ${token} ${((Date.now() - started) / 1000).toFixed(1)}s`,
    );
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

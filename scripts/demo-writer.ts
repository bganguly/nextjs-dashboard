/**
 * Demo writer: inserts one random order every 500ms and
 * sends a Postgres NOTIFY on channel "orders_channel".
 *
 * Run with:
 *   npx tsx scripts/demo-writer.ts
 */

import { PrismaClient } from "@prisma/client";
import { faker } from "@faker-js/faker";
import { Client } from "pg";
import { resolvePgUrl } from "../lib/pg-url";

const prisma = new PrismaClient({ log: ["error"] });
// Raw pg (for NOTIFY) needs a standard postgresql:// URL — DATABASE_URL may be a
// prisma+postgres:// proxy URL the pg driver cannot parse. See lib/pg-url.ts.
const pg = new Client({ connectionString: resolvePgUrl() });

async function pickRandom<T extends { id: number }>(
  findMany: (args: { take: number; skip: number; select: { id: true } }) => Promise<T[]>,
  count: number
): Promise<number> {
  const skip = faker.number.int({ min: 0, max: Math.max(0, count - 1) });
  const rows = await findMany({ take: 1, skip, select: { id: true } });
  return rows[0].id;
}

async function insertOrder() {
  const [customerCount, regionCount, productCount] = await Promise.all([
    prisma.customer.count(),
    prisma.region.count(),
    prisma.product.count(),
  ]);

  if (customerCount === 0 || regionCount === 0 || productCount === 0) {
    console.warn("No seed data found — run scripts/seed.ts first");
    return;
  }

  const [customerId, regionId] = await Promise.all([
    pickRandom((a) => prisma.customer.findMany(a), customerCount),
    pickRandom((a) => prisma.region.findMany(a), regionCount),
  ]);

  const itemCount = faker.number.int({ min: 1, max: 4 });
  const items = await Promise.all(
    Array.from({ length: itemCount }, async () => {
      const productId = await pickRandom((a) => prisma.product.findMany(a), productCount);
      const unitPrice = parseFloat(faker.commerce.price({ min: 1, max: 300 }));
      const quantity = faker.number.int({ min: 1, max: 5 });
      return { productId, unitPrice, quantity, discount: 0 };
    })
  );

  const total = items.reduce((s, it) => s + it.unitPrice * it.quantity, 0);

  const order = await prisma.order.create({
    data: {
      customerId,
      regionId,
      total: parseFloat(total.toFixed(2)),
      currency: "USD",
      items: { create: items },
    },
    include: {
      customer: { select: { id: true, email: true } },
      region: { select: { code: true } },
    },
  });

  const payload = JSON.stringify({
    id: order.id,
    total: order.total,
    customerId: order.customerId,
    customerEmail: order.customer.email,
    regionCode: order.region.code,
    placedAt: order.placedAt,
  });

  await pg.query(`SELECT pg_notify('orders_channel', $1)`, [payload]);
  console.log(`[${new Date().toISOString()}] order #${order.id} total=$${order.total}`);
}

async function main() {
  await pg.connect();
  console.log("demo-writer started — inserting one order every 500ms");

  const run = async () => {
    try {
      await insertOrder();
    } catch (err) {
      console.error("insert failed:", err instanceof Error ? err.message : err);
    }
  };

  // Run immediately, then on interval
  await run();
  const interval = setInterval(run, 500);

  const stop = async () => {
    clearInterval(interval);
    await Promise.all([prisma.$disconnect(), pg.end()]);
    console.log("demo-writer stopped");
    process.exit(0);
  };

  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

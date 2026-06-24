/**
 * Bulk seed script. Targets:
 *   categories  1 000
 *   regions       100
 *   products   10 000
 *   customers 500 000
 *   orders      4 000 000
 *   order_items 4 000 000 (1 item per order on average; actual total may vary)
 *
 * Uses batched createMany for efficiency. Run with:
 *   npx tsx scripts/seed.ts
 */

import { PrismaClient, OrderStatus } from "@prisma/client";
import { faker } from "@faker-js/faker";

const prisma = new PrismaClient({ log: ["warn", "error"] });

const CATEGORY_COUNT = 1_000;
const REGION_COUNT = 100;
const PRODUCT_COUNT = 10_000;
const CUSTOMER_COUNT = 500_000;
const ORDER_COUNT = 4_000_000;
const BATCH = 5_000;

const ORDER_STATUSES: OrderStatus[] = [
  "PENDING", "CONFIRMED", "PROCESSING", "SHIPPED", "DELIVERED", "CANCELLED", "REFUNDED",
];

async function seedCategories() {
  console.log("Seeding categories...");
  const data = Array.from({ length: CATEGORY_COUNT }, (_, i) => {
    const name = `${faker.commerce.department()}-${i}`;
    return { name, slug: name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "") };
  });
  // deduplicate slugs
  const seen = new Set<string>();
  const unique = data.filter((d) => {
    if (seen.has(d.slug)) return false;
    seen.add(d.slug);
    return true;
  });
  await prisma.category.createMany({ data: unique, skipDuplicates: true });
  console.log(`  inserted ${unique.length} categories`);
}

async function seedRegions() {
  console.log("Seeding regions...");
  const data = Array.from({ length: REGION_COUNT }, (_, i) => ({
    code: `R${String(i + 1).padStart(3, "0")}`,
    name: faker.location.state(),
    country: faker.location.country(),
    timezone: faker.location.timeZone(),
  }));
  await prisma.region.createMany({ data, skipDuplicates: true });
  console.log(`  inserted ${data.length} regions`);
}

async function seedProducts(categoryIds: number[]) {
  console.log("Seeding products...");
  let count = 0;
  for (let i = 0; i < PRODUCT_COUNT; i += BATCH) {
    const batchSize = Math.min(BATCH, PRODUCT_COUNT - i);
    const data = Array.from({ length: batchSize }, (_, j) => {
      const price = parseFloat(faker.commerce.price({ min: 1, max: 1000 }));
      return {
        sku: `SKU-${i + j + 1}`,
        name: faker.commerce.productName(),
        description: faker.commerce.productDescription(),
        price,
        cost: parseFloat((price * 0.6).toFixed(2)),
        stock: faker.number.int({ min: 0, max: 5000 }),
        categoryId: categoryIds[faker.number.int({ min: 0, max: categoryIds.length - 1 })],
      };
    });
    await prisma.product.createMany({ data, skipDuplicates: true });
    count += data.length;
    process.stdout.write(`\r  ${count} / ${PRODUCT_COUNT}`);
  }
  console.log();
}

async function seedCustomers(regionIds: number[]) {
  console.log("Seeding customers...");
  let count = 0;
  for (let i = 0; i < CUSTOMER_COUNT; i += BATCH) {
    const batchSize = Math.min(BATCH, CUSTOMER_COUNT - i);
    const data = Array.from({ length: batchSize }, (_, j) => ({
      email: `user${i + j + 1}@${faker.internet.domainName()}`,
      firstName: faker.person.firstName(),
      lastName: faker.person.lastName(),
      phone: faker.phone.number(),
      regionId: regionIds[faker.number.int({ min: 0, max: regionIds.length - 1 })],
    }));
    await prisma.customer.createMany({ data, skipDuplicates: true });
    count += data.length;
    if (count % 50_000 === 0) process.stdout.write(`\r  ${count} / ${CUSTOMER_COUNT}`);
  }
  console.log(`\r  ${count} / ${CUSTOMER_COUNT}`);
}

async function seedOrders(customerIds: number[], regionIds: number[], productIds: number[]) {
  console.log("Seeding orders + order_items...");
  let orderCount = 0;

  for (let i = 0; i < ORDER_COUNT; i += BATCH) {
    const batchSize = Math.min(BATCH, ORDER_COUNT - i);

    // Build orders then items in a transaction per batch
    await prisma.$transaction(async (tx) => {
      const orderData = Array.from({ length: batchSize }, () => {
        const itemCount = faker.number.int({ min: 1, max: 5 });
        const items = Array.from({ length: itemCount }, () => {
          const unitPrice = parseFloat(faker.commerce.price({ min: 1, max: 500 }));
          const quantity = faker.number.int({ min: 1, max: 10 });
          return { unitPrice, quantity };
        });
        const total = items.reduce((s, it) => s + it.unitPrice * it.quantity, 0);
        return {
          customerId: customerIds[faker.number.int({ min: 0, max: customerIds.length - 1 })],
          regionId: regionIds[faker.number.int({ min: 0, max: regionIds.length - 1 })],
          status: ORDER_STATUSES[faker.number.int({ min: 0, max: ORDER_STATUSES.length - 1 })],
          total: parseFloat(total.toFixed(2)),
          currency: "USD",
          placedAt: faker.date.between({ from: "2023-01-01", to: new Date() }),
          items,
        };
      });

      for (const od of orderData) {
        const { items, ...orderFields } = od;
        const order = await tx.order.create({
          data: {
            ...orderFields,
            items: {
              create: items.map((it) => ({
                productId: productIds[faker.number.int({ min: 0, max: productIds.length - 1 })],
                quantity: it.quantity,
                unitPrice: it.unitPrice,
                discount: 0,
              })),
            },
          },
        });
        void order;
      }
    });

    orderCount += batchSize;
    if (orderCount % 50_000 === 0 || orderCount === ORDER_COUNT) {
      process.stdout.write(`\r  ${orderCount} / ${ORDER_COUNT} orders`);
    }
  }
  console.log();
}

async function main() {
  console.time("seed");

  await seedCategories();
  await seedRegions();

  const [categoryIds, regionIds] = await Promise.all([
    prisma.category.findMany({ select: { id: true } }).then((r) => r.map((c) => c.id)),
    prisma.region.findMany({ select: { id: true } }).then((r) => r.map((c) => c.id)),
  ]);

  await seedProducts(categoryIds);
  await seedCustomers(regionIds);

  const [customerIds, productIds] = await Promise.all([
    prisma.customer.findMany({ select: { id: true } }).then((r) => r.map((c) => c.id)),
    prisma.product.findMany({ select: { id: true } }).then((r) => r.map((c) => c.id)),
  ]);

  await seedOrders(customerIds, regionIds, productIds);

  console.timeEnd("seed");
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

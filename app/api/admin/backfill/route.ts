import { NextResponse } from "next/server";
import { query, execute } from "@/lib/db";
import { backfillState } from "@/lib/backfill-state";

async function isEmpty(table: string): Promise<boolean> {
  const [{ count }] = await query<{ count: string }>(`SELECT COUNT(*) AS count FROM ${table}`);
  return Number(count) === 0;
}

function runBackfillInBackground() {
  if (backfillState.started) return;
  backfillState.started = true;

  Promise.resolve().then(async () => {
    // step 1: order_category_facts
    backfillState.steps.order_category_facts = "running";
    if (await isEmpty("order_category_facts")) {
      await execute(`
        INSERT INTO order_category_facts
          (order_id, placed_at, date, region_id, region_code, status, order_total,
           category_id, category_name, total_items, total_revenue)
        SELECT o.order_id, o.placed_at, DATE(o.placed_at),
               o.region_id, o.region_code, o.status, o.total,
               oi.category_id, oi.category_name,
               SUM(oi.quantity)::int,
               SUM(oi.quantity * oi.unit_price * (1 - oi.discount / 100))
        FROM orders o
        JOIN order_items oi ON o.order_id = oi.order_id
        GROUP BY o.order_id, o.placed_at, o.region_id, o.region_code,
                 o.status, o.total, oi.category_id, oi.category_name
        ON CONFLICT DO NOTHING
      `);
      backfillState.steps.order_category_facts = "done";
    } else {
      backfillState.steps.order_category_facts = "skipped";
    }

    // step 2: daily_order_count
    backfillState.steps.daily_order_count = "running";
    if (await isEmpty("daily_order_count")) {
      await execute(`
        INSERT INTO daily_order_count (date, total_orders)
        SELECT DATE(placed_at), COUNT(*)::int
        FROM orders GROUP BY DATE(placed_at)
        ON CONFLICT (date) DO NOTHING
      `);
      backfillState.steps.daily_order_count = "done";
    } else {
      backfillState.steps.daily_order_count = "skipped";
    }

    // step 3: daily_summary (depends on order_category_facts)
    backfillState.steps.daily_summary = "running";
    if (await isEmpty("daily_summary")) {
      await execute(`
        INSERT INTO daily_summary
          (date, category_id, category_name, region_id, region_code,
           total_orders, total_revenue, total_items, avg_order_value, created_at, updated_at)
        SELECT ocf.date, ocf.category_id, ocf.category_name, o.region_id, o.region_code,
               COUNT(DISTINCT ocf.order_id)::int,
               SUM(ocf.total_revenue),
               SUM(ocf.total_items)::int,
               ROUND(SUM(ocf.order_total) / NULLIF(COUNT(DISTINCT ocf.order_id), 0), 2),
               NOW(), NOW()
        FROM order_category_facts ocf
        JOIN orders o ON ocf.order_id = o.order_id
        GROUP BY ocf.date, ocf.category_id, ocf.category_name, o.region_id, o.region_code
        ON CONFLICT (date, category_id, region_id) DO NOTHING
      `);
      backfillState.steps.daily_summary = "done";
    } else {
      backfillState.steps.daily_summary = "skipped";
    }

    backfillState.done = true;
  }).catch((err) => {
    backfillState.error = String(err);
    backfillState.done = true;
    console.error("[backfill]", err);
  });
}

export async function GET() {
  runBackfillInBackground();
  return NextResponse.json({ status: "started", state: backfillState }, { status: 202 });
}

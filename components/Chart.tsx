"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bar,
  BarChart,
  Brush,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useIsDark } from "@/hooks/useIsDark";

/** One x-axis bucket. `date` is the label; every other numeric key is a stack series. */
export interface AggregateBucket {
  date: string;
  [series: string]: string | number;
}

/** Per-category metrics within a date, as sent by the backend. */
interface RawCategory {
  totalOrders?: number;
  totalRevenue?: number;
  totalItems?: number;
  avgOrderValue?: number;
}

/**
 * Raw backend row: a date plus its per-category breakdown, keyed by category
 * name (an object, not an array): `{ "Category 1": { totalRevenue, ... } }`.
 */
interface RawAggregate {
  date: string;
  categories: Record<string, RawCategory>;
}

interface AggregatesResponse {
  data: RawAggregate[];
}

const DEFAULT_TOP_N = 5;
const OTHER_KEY = "Other";
const OTHER_COLOR = "#94a3b8"; // slate-400

export interface CategoryTotal {
  category: string;
  revenue: number;
  orders: number;
}

/** Sum revenue and order count per category across the range, sorted desc. */
function computeCategoryTotals(data: RawAggregate[]): CategoryTotal[] {
  const map = new Map<string, { revenue: number; orders: number }>();
  for (const entry of data) {
    for (const [category, c] of Object.entries(entry.categories ?? {})) {
      const prev = map.get(category) ?? { revenue: 0, orders: 0 };
      prev.revenue += c.totalRevenue ?? 0;
      prev.orders += c.totalOrders ?? 0;
      map.set(category, prev);
    }
  }
  return [...map.entries()]
    .map(([category, v]) => ({ category, revenue: v.revenue, orders: v.orders }))
    .sort((a, b) => b.revenue - a.revenue);
}

/**
 * Build one stacked bucket per date, keeping only `topCategories` as their own
 * revenue series and rolling every other category into a single "Other" series.
 */
function buildBucket(
  entry: RawAggregate,
  topCategories: string[],
  withOther: boolean,
): AggregateBucket {
  const top = new Set(topCategories);
  const bucket: AggregateBucket = { date: entry.date };
  for (const cat of topCategories) bucket[cat] = 0;
  if (withOther) bucket[OTHER_KEY] = 0;
  for (const [category, c] of Object.entries(entry.categories ?? {})) {
    const revenue = c.totalRevenue ?? 0;
    // Non-top categories (including any backend-provided "Other") merge into
    // the single rolled-up "Other" series.
    const key = top.has(category) ? category : withOther ? OTHER_KEY : null;
    if (key === null) continue;
    bucket[key] = (bucket[key] as number) + revenue;
  }
  return bucket;
}

const currencyFmt = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});
const numberFmt = new Intl.NumberFormat("en-US");

interface ChartProps {
  /** Bumped by the SSE LiveFeed to force a refetch of the current range. */
  refreshSignal?: number;
  /** Endpoint that returns stacked aggregates for a date range. */
  endpoint?: string;
  /** How many categories to stack individually; the rest roll into "Other". */
  topN?: number;
}

// Stable palette for stacked series. Cycled if there are more series than colors.
const COLORS = [
  "#6366f1",
  "#22c55e",
  "#f59e0b",
  "#ef4444",
  "#06b6d4",
  "#a855f7",
  "#ec4899",
];

const STACK_ID = "aggregates";
const DRAG_DEBOUNCE_MS = 250;

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function defaultRange(): { from: string; to: string } {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - 30);
  return { from: isoDay(from), to: isoDay(to) };
}

export default function Chart({
  refreshSignal = 0,
  endpoint = "/api/aggregates",
  topN = DEFAULT_TOP_N,
}: ChartProps) {
  const [rawData, setRawData] = useState<RawAggregate[]>([]);
  const [range, setRange] = useState(defaultRange);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Abort in-flight requests so rapid drags don't race each other.
  const abortRef = useRef<AbortController | null>(null);
  const dragTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchAggregates = useCallback(
    async (from: string, to: string) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({ from, to });
        // Forward-compatible: honoured if the backend adds it; otherwise we
        // roll up to the top N client-side below.
        params.set("topCategories", String(topN));
        const res = await fetch(`${endpoint}?${params}`, {
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json: AggregatesResponse = await res.json();
        setRawData(Array.isArray(json.data) ? json.data : []);
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        setError((err as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [endpoint, topN],
  );

  // Initial load + refetch whenever the SSE refresh signal changes.
  useEffect(() => {
    // Kicks off an async fetch (which toggles loading state); intentional.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchAggregates(range.from, range.to);
    // range.from/range.to intentionally omitted: drag handles its own fetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchAggregates, refreshSignal]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      if (dragTimer.current) clearTimeout(dragTimer.current);
    };
  }, []);

  const isDark = useIsDark();
  // recharts renders raw SVG and can't use Tailwind `dark:` utilities, so pick
  // grid/axis/tooltip colors from the resolved theme.
  const gridStroke = isDark ? "#374151" : "#e5e7eb";
  const axisColor = isDark ? "#9ca3af" : "#6b7280";
  const tooltipStyle = {
    backgroundColor: isDark ? "#1f2937" : "#ffffff",
    border: `1px solid ${isDark ? "#374151" : "#e5e7eb"}`,
    borderRadius: 8,
    color: isDark ? "#f3f4f6" : "#111827",
  };

  // Per-category totals for the current range (drives the summary table).
  const categoryTotals = useMemo(
    () => computeCategoryTotals(rawData),
    [rawData],
  );

  // Stack only the top N *real* categories; everything else (including any
  // backend-provided "Other" pseudo-category) rolls into a single "Other".
  const topCategories = useMemo(
    () =>
      categoryTotals
        .filter((c) => c.category !== OTHER_KEY)
        .slice(0, topN)
        .map((c) => c.category),
    [categoryTotals, topN],
  );
  const withOther = categoryTotals.length > topCategories.length;

  const buckets = useMemo(
    () => rawData.map((entry) => buildBucket(entry, topCategories, withOther)),
    [rawData, topCategories, withOther],
  );

  const seriesKeys = useMemo(
    () => (withOther ? [...topCategories, OTHER_KEY] : topCategories),
    [topCategories, withOther],
  );

  // Color per top category (by rank), with a fixed neutral for "Other".
  const colorByCategory = useMemo(() => {
    const map = new Map<string, string>();
    topCategories.forEach((c, i) => map.set(c, COLORS[i % COLORS.length]));
    return map;
  }, [topCategories]);
  const colorFor = (key: string) =>
    key === OTHER_KEY ? OTHER_COLOR : (colorByCategory.get(key) ?? OTHER_COLOR);

  // Dragging the Brush selects a date window; debounce then refetch that window.
  const handleBrushChange = useCallback(
    (next: { startIndex?: number; endIndex?: number }) => {
      const { startIndex, endIndex } = next;
      if (
        startIndex == null ||
        endIndex == null ||
        !buckets.length ||
        startIndex < 0 ||
        endIndex >= buckets.length
      ) {
        return;
      }
      const from = String(buckets[startIndex].date);
      const to = String(buckets[endIndex].date);
      if (from === range.from && to === range.to) return;

      setRange({ from, to });
      if (dragTimer.current) clearTimeout(dragTimer.current);
      dragTimer.current = setTimeout(() => {
        fetchAggregates(from, to);
      }, DRAG_DEBOUNCE_MS);
    },
    [buckets, range.from, range.to, fetchAggregates],
  );

  return (
    <section
      data-testid="chart"
      className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-800 dark:bg-gray-900"
    >
      <header className="mb-3 flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold">Aggregates</h2>
          <p className="text-xs text-gray-500">
            {range.from} → {range.to}
            <span className="ml-2 text-gray-400">drag the slider to rescan</span>
          </p>
        </div>
        {loading && (
          <span className="text-xs text-indigo-500" aria-live="polite">
            updating…
          </span>
        )}
      </header>

      {error ? (
        <div className="flex h-72 items-center justify-center text-sm text-red-500">
          Failed to load aggregates: {error}
        </div>
      ) : buckets.length === 0 ? (
        <div className="flex h-72 items-center justify-center text-sm text-gray-400">
          No data for this range.
        </div>
      ) : (
        <>
        <ResponsiveContainer width="100%" height={320}>
          <BarChart
            data={buckets}
            margin={{ top: 8, right: 16, left: 0, bottom: 0 }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} />
            <XAxis
              dataKey="date"
              fontSize={12}
              tickMargin={8}
              stroke={axisColor}
              tick={{ fill: axisColor }}
            />
            <YAxis
              fontSize={12}
              width={48}
              stroke={axisColor}
              tick={{ fill: axisColor }}
            />
            <Tooltip
              contentStyle={tooltipStyle}
              labelStyle={{ color: tooltipStyle.color }}
              itemStyle={{ color: tooltipStyle.color }}
              cursor={{ fill: isDark ? "#ffffff10" : "#00000008" }}
            />
            <Legend wrapperStyle={{ fontSize: 12, color: axisColor }} />
            {seriesKeys.map((key, i) => (
              <Bar
                key={key}
                dataKey={key}
                stackId={STACK_ID}
                fill={colorFor(key)}
                radius={
                  i === seriesKeys.length - 1 ? [4, 4, 0, 0] : [0, 0, 0, 0]
                }
              />
            ))}
            <Brush
              dataKey="date"
              height={28}
              stroke="#6366f1"
              fill={isDark ? "#111827" : "#ffffff"}
              travellerWidth={10}
              onChange={handleBrushChange}
            />
          </BarChart>
        </ResponsiveContainer>

        {/* Category totals for the current range, sorted by revenue desc. */}
        <div data-testid="category-totals" className="mt-4 overflow-x-auto">
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500">
            Category totals
          </p>
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-gray-200 text-left text-gray-500 dark:border-gray-800">
                <th className="py-1 pr-3 font-medium">Category</th>
                <th className="py-1 pr-3 text-right font-medium">Revenue</th>
                <th className="py-1 text-right font-medium">Orders</th>
              </tr>
            </thead>
            <tbody>
              {categoryTotals.map((ct) => (
                <tr
                  key={ct.category}
                  className="border-b border-gray-100 last:border-0 dark:border-gray-800/60"
                >
                  <td className="py-1 pr-3">
                    <span className="inline-flex items-center gap-1.5">
                      <span
                        aria-hidden
                        className="h-2 w-2 rounded-sm"
                        style={{
                          backgroundColor:
                            colorByCategory.get(ct.category) ?? OTHER_COLOR,
                        }}
                      />
                      {ct.category}
                    </span>
                  </td>
                  <td className="py-1 pr-3 text-right tabular-nums">
                    {currencyFmt.format(ct.revenue)}
                  </td>
                  <td className="py-1 text-right tabular-nums">
                    {numberFmt.format(ct.orders)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        </>
      )}
    </section>
  );
}

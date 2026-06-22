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
import { appendFilterParams, type OrderFilters } from "@/components/FilterSidebar";

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

const DEFAULT_TOP_N = 8;
const OTHER_KEY = "Others";
const OTHER_COLOR = "#94a3b8"; // slate-400

/** Whether a category name is a roll-up bucket ("Other"/"Others"), case-insensitive. */
function isOtherCategory(name: string): boolean {
  const n = name.trim().toLowerCase();
  return n === "other" || n === "others";
}

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
    // Non-top categories (including any backend-provided "Other"/"Others") merge
    // into the single rolled-up "Others" series.
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

/**
 * Abbreviate large revenue values for the Y axis: 25000 → "25k", 1_200_000 →
 * "1.2M". Hand-rolled (rather than Intl compact) to keep lowercase "k" and
 * avoid the "25K" casing surprise. Drops the decimal on round values.
 */
const compactNumber = (n: number): string => {
  const abs = Math.abs(n);
  if (abs >= 1_000_000)
    return `${(n / 1_000_000).toFixed(abs % 1_000_000 ? 1 : 0)}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(abs % 1_000 ? 1 : 0)}k`;
  return `${n}`;
};

interface ChartProps {
  /** Bumped by the SSE LiveFeed to force a refetch of the current range. */
  refreshSignal?: number;
  /** Endpoint that returns stacked aggregates for a date range. */
  endpoint?: string;
  /** How many categories to stack individually; the rest roll into "Others". */
  topN?: number;
  /** Sidebar filters; applied to the aggregates request so the chart and totals
   *  recompute for the same filtered set as the orders table. */
  filters?: OrderFilters;
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
  filters,
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
        // A date filter, if set, overrides the brush/default range; the other
        // filters (status, region, total) narrow the same set as the table.
        const params = new URLSearchParams({
          from: filters?.from || from,
          to: filters?.to || to,
        });
        params.set("topCategories", String(topN));
        // Sets status/regionCode/minTotal/maxTotal (and from/to if filtered).
        appendFilterParams(params, filters);
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
    [endpoint, topN, filters],
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
  // backend-provided "Other"/"Others" pseudo-category) rolls into a single
  // "Others" series.
  const topCategories = useMemo(
    () =>
      categoryTotals
        .filter((c) => !isOtherCategory(c.category))
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

  // Revenue per displayed series (top categories + a single rolled-up "Others"),
  // sorted desc — mirrors exactly what the chart stacks. Drives the totals row.
  const displayTotals = useMemo(() => {
    const topSet = new Set(topCategories);
    const rows = topCategories.map((cat) => ({
      category: cat,
      revenue: categoryTotals.find((c) => c.category === cat)?.revenue ?? 0,
    }));
    if (withOther) {
      const othersRevenue = categoryTotals
        .filter((c) => !topSet.has(c.category))
        .reduce((sum, c) => sum + c.revenue, 0);
      rows.push({ category: OTHER_KEY, revenue: othersRevenue });
    }
    return rows.sort((a, b) => b.revenue - a.revenue);
  }, [categoryTotals, topCategories, withOther]);

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
              width={56}
              stroke={axisColor}
              tick={{ fill: axisColor }}
              tickFormatter={compactNumber}
            />
            <Tooltip
              contentStyle={tooltipStyle}
              labelStyle={{ color: tooltipStyle.color }}
              itemStyle={{ color: tooltipStyle.color }}
              cursor={{ fill: isDark ? "#ffffff10" : "#00000008" }}
              formatter={(v) => currencyFmt.format(Number(v))}
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

        {/* Category totals for the current range as a single wrapping row,
            sorted by revenue desc, mirroring the chart's series + "Others". */}
        <div className="mt-4">
          <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500">
            Category totals
          </p>
          <div
            data-testid="category-totals"
            className="flex flex-wrap items-center gap-x-4 gap-y-2"
          >
            {displayTotals.map((ct) => (
              <span
                key={ct.category}
                className="inline-flex items-center gap-1.5 text-xs"
                title={currencyFmt.format(ct.revenue)}
              >
                <span
                  aria-hidden
                  className="h-2.5 w-2.5 shrink-0 rounded-sm"
                  style={{ backgroundColor: colorFor(ct.category) }}
                />
                <span className="text-gray-600 dark:text-gray-300">
                  {ct.category}
                </span>
                <span className="font-medium tabular-nums text-gray-900 dark:text-gray-100">
                  ${compactNumber(ct.revenue)}
                </span>
              </span>
            ))}
          </div>
        </div>
        </>
      )}
    </section>
  );
}

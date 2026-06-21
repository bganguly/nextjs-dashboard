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

/** One x-axis bucket. `date` is the label; every other numeric key is a stack series. */
export interface AggregateBucket {
  date: string;
  [series: string]: string | number;
}

interface AggregatesResponse {
  buckets: AggregateBucket[];
}

interface ChartProps {
  /** Bumped by the SSE LiveFeed to force a refetch of the current range. */
  refreshSignal?: number;
  /** Endpoint that returns stacked aggregates for a date range. */
  endpoint?: string;
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
}: ChartProps) {
  const [buckets, setBuckets] = useState<AggregateBucket[]>([]);
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
        const res = await fetch(`${endpoint}?${params}`, {
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json: AggregatesResponse = await res.json();
        setBuckets(Array.isArray(json.buckets) ? json.buckets : []);
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        setError((err as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [endpoint],
  );

  // Initial load + refetch whenever the SSE refresh signal changes.
  useEffect(() => {
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

  // Derive the stacked series keys from the data (every numeric field).
  const seriesKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const b of buckets) {
      for (const [k, v] of Object.entries(b)) {
        if (k !== "date" && typeof v === "number") keys.add(k);
      }
    }
    return Array.from(keys);
  }, [buckets]);

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
    <section className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-800 dark:bg-gray-900">
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
        <ResponsiveContainer width="100%" height={320}>
          <BarChart
            data={buckets}
            margin={{ top: 8, right: 16, left: 0, bottom: 0 }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
            <XAxis dataKey="date" fontSize={12} tickMargin={8} />
            <YAxis fontSize={12} width={48} />
            <Tooltip />
            <Legend />
            {seriesKeys.map((key, i) => (
              <Bar
                key={key}
                dataKey={key}
                stackId={STACK_ID}
                fill={COLORS[i % COLORS.length]}
                radius={
                  i === seriesKeys.length - 1 ? [4, 4, 0, 0] : [0, 0, 0, 0]
                }
              />
            ))}
            <Brush
              dataKey="date"
              height={28}
              stroke="#6366f1"
              travellerWidth={10}
              onChange={handleBrushChange}
            />
          </BarChart>
        </ResponsiveContainer>
      )}
    </section>
  );
}

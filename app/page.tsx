"use client";

import { useCallback, useState } from "react";
import Chart from "@/components/Chart";
import SearchTable, { type SearchRow } from "@/components/SearchTable";
import LiveFeed from "@/components/LiveFeed";
import ThemeToggle from "@/components/ThemeToggle";
import FilterSidebar, {
  EMPTY_FILTERS,
  type OrderFilters,
} from "@/components/FilterSidebar";

/**
 * Dashboard shell. A single SSE connection lives in LiveFeed; each event bumps
 * `refreshSignal`, which Chart and SearchTable watch to refetch their current
 * views. This keeps one EventSource for the whole page instead of one per panel.
 *
 * The filter sidebar's state lives here and is passed to SearchTable, which
 * sends it to /api/orders. Region options have no dedicated endpoint, so they
 * are discovered from the order rows SearchTable reports via `onRows`.
 */
export default function Dashboard() {
  const [refreshSignal, setRefreshSignal] = useState(0);
  const [filters, setFilters] = useState<OrderFilters>(EMPTY_FILTERS);
  const [regionOptions, setRegionOptions] = useState<string[]>([]);

  const handleEvent = useCallback(() => {
    setRefreshSignal((n) => n + 1);
  }, []);

  // Accumulate distinct region codes seen in the loaded orders.
  const handleRows = useCallback((rows: SearchRow[]) => {
    setRegionOptions((prev) => {
      const set = new Set(prev);
      for (const row of rows) {
        const region = row.region as { code?: string } | undefined;
        if (region?.code) set.add(region.code);
      }
      const next = [...set].sort();
      return next.length === prev.length ? prev : next;
    });
  }, []);

  return (
    <div className="min-h-screen bg-zinc-50 font-sans dark:bg-black">
      <main className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        <header className="mb-6 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
            <p className="text-sm text-gray-500">
              Live aggregates, search, and event stream.
            </p>
          </div>
          <ThemeToggle />
        </header>

        <div className="flex flex-col gap-6 lg:flex-row">
          <FilterSidebar
            value={filters}
            onChange={setFilters}
            regionOptions={regionOptions}
          />

          <div className="min-w-0 flex-1">
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
              <div className="space-y-6 lg:col-span-2">
                <Chart refreshSignal={refreshSignal} />
                <SearchTable
                  refreshSignal={refreshSignal}
                  filters={filters}
                  onRows={handleRows}
                />
              </div>
              <div className="lg:col-span-1">
                <LiveFeed onEvent={handleEvent} />
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

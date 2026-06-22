"use client";

import { useCallback, useEffect, useState } from "react";
import Chart from "@/components/Chart";
import SearchTable, { type SearchRow } from "@/components/SearchTable";
import LiveFeed from "@/components/LiveFeed";
import ThemeToggle from "@/components/ThemeToggle";
import FilterSidebar, {
  EMPTY_FILTERS,
  type OrderFilters,
  type RegionOption,
} from "@/components/FilterSidebar";

/** Merge new regions into the list by code (name wins if present), sorted. */
function mergeRegions(
  prev: RegionOption[],
  incoming: RegionOption[],
): RegionOption[] {
  const map = new Map(prev.map((r) => [r.code, r]));
  let changed = false;
  for (const r of incoming) {
    if (!r?.code) continue;
    const existing = map.get(r.code);
    const name = r.name || existing?.name || r.code;
    if (!existing || existing.name !== name) {
      map.set(r.code, { code: r.code, name });
      changed = true;
    }
  }
  if (!changed) return prev;
  return [...map.values()].sort((a, b) => a.code.localeCompare(b.code));
}

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
  const [regionOptions, setRegionOptions] = useState<RegionOption[]>([]);

  const handleEvent = useCallback(() => {
    setRefreshSignal((n) => n + 1);
  }, []);

  // Prefer the full region list (with display names) from /api/regions. If that
  // endpoint isn't available we fall back to codes discovered from order rows.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/regions")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status}`))))
      .then((data: RegionOption[]) => {
        if (cancelled || !Array.isArray(data)) return;
        setRegionOptions((prev) => mergeRegions(prev, data));
      })
      .catch(() => {
        /* no regions endpoint — handleRows discovery covers it */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Discover region codes from loaded orders (fallback / supplement; uses the
  // region name from the row when present, else the code).
  const handleRows = useCallback((rows: SearchRow[]) => {
    const incoming: RegionOption[] = [];
    for (const row of rows) {
      const region = row.region as { code?: string; name?: string } | undefined;
      if (region?.code) {
        incoming.push({ code: region.code, name: region.name ?? region.code });
      }
    }
    if (incoming.length === 0) return;
    setRegionOptions((prev) => mergeRegions(prev, incoming));
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

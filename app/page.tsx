"use client";

import { useCallback, useState } from "react";
import Chart from "@/components/Chart";
import SearchTable from "@/components/SearchTable";
import LiveFeed from "@/components/LiveFeed";
import ThemeToggle from "@/components/ThemeToggle";

/**
 * Dashboard shell. A single SSE connection lives in LiveFeed; each event bumps
 * `refreshSignal`, which Chart and SearchTable watch to refetch their current
 * views. This keeps one EventSource for the whole page instead of one per panel.
 */
export default function Dashboard() {
  const [refreshSignal, setRefreshSignal] = useState(0);

  const handleEvent = useCallback(() => {
    setRefreshSignal((n) => n + 1);
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

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <div className="space-y-6 lg:col-span-2">
            <Chart refreshSignal={refreshSignal} />
            <SearchTable refreshSignal={refreshSignal} />
          </div>
          <div className="lg:col-span-1">
            <LiveFeed onEvent={handleEvent} />
          </div>
        </div>
      </main>
    </div>
  );
}

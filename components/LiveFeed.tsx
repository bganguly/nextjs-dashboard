"use client";

import { useCallback, useState } from "react";
import { useSSE, type SSEStatus } from "@/hooks/useSSE";

/** Shape of a live event. `id`/`type`/`message` are optional, rendered if present. */
export interface LiveEvent {
  id?: string | number;
  type?: string;
  message?: string;
  timestamp?: string | number;
  [key: string]: unknown;
}

interface LiveFeedProps {
  /**
   * Called on every SSE event. The dashboard uses this to bump a shared
   * refresh signal so Chart and SearchTable refetch their current views.
   */
  onEvent?: (event: LiveEvent) => void;
  endpoint?: string;
  /** How many recent events to keep in the visible feed. */
  maxItems?: number;
}

const STATUS_STYLES: Record<SSEStatus, { dot: string; label: string }> = {
  open: { dot: "bg-green-500", label: "Live" },
  connecting: { dot: "bg-amber-500 animate-pulse", label: "Connecting…" },
  error: { dot: "bg-red-500 animate-pulse", label: "Reconnecting…" },
  closed: { dot: "bg-gray-400", label: "Offline" },
};

function eventTime(e: LiveEvent): string {
  const raw = e.timestamp;
  const d = raw != null ? new Date(raw) : new Date();
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString();
}

function eventLabel(e: LiveEvent): string {
  if (e.message) return e.message;
  if (e.type) return e.type;
  return JSON.stringify(e);
}

export default function LiveFeed({
  onEvent,
  endpoint = "/api/stream",
  maxItems = 25,
}: LiveFeedProps) {
  const [items, setItems] = useState<LiveEvent[]>([]);

  const handleMessage = useCallback(
    (data: LiveEvent) => {
      setItems((prev) => [data, ...prev].slice(0, maxItems));
      onEvent?.(data);
    },
    [onEvent, maxItems],
  );

  const { status } = useSSE<LiveEvent>(endpoint, { onMessage: handleMessage });
  const statusStyle = STATUS_STYLES[status];

  return (
    <section className="flex h-full flex-col rounded-lg border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-800 dark:bg-gray-900">
      <header className="mb-3 flex items-center justify-between">
        <h2 className="text-base font-semibold">Live Feed</h2>
        <span className="flex items-center gap-2 text-xs text-gray-500">
          <span className={`h-2 w-2 rounded-full ${statusStyle.dot}`} />
          {statusStyle.label}
        </span>
      </header>

      <ul className="flex-1 space-y-1 overflow-y-auto text-sm">
        {items.length === 0 ? (
          <li className="py-8 text-center text-gray-400">
            Waiting for events…
          </li>
        ) : (
          items.map((e, i) => (
            <li
              key={e.id ?? `${i}-${e.timestamp ?? ""}`}
              className="flex items-baseline gap-2 border-b border-gray-100 py-1.5 last:border-0 dark:border-gray-800"
            >
              <time className="shrink-0 font-mono text-xs text-gray-400">
                {eventTime(e)}
              </time>
              {e.type && (
                <span className="shrink-0 rounded bg-indigo-50 px-1.5 py-0.5 text-xs font-medium text-indigo-600 dark:bg-indigo-950 dark:text-indigo-300">
                  {e.type}
                </span>
              )}
              <span className="truncate text-gray-700 dark:text-gray-200">
                {eventLabel(e)}
              </span>
            </li>
          ))
        )}
      </ul>
    </section>
  );
}

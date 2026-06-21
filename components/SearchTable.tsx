"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/** A result row. Columns are derived from the keys present in the rows. */
export type SearchRow = Record<string, unknown>;

interface SearchResponse {
  rows: SearchRow[];
  /** Opaque cursor for the next page, or null when there are no more results. */
  nextCursor: string | null;
}

interface SearchTableProps {
  /** Bumped by the SSE LiveFeed to refetch the current page on new events. */
  refreshSignal?: number;
  endpoint?: string;
  pageSize?: number;
}

const SEARCH_DEBOUNCE_MS = 300;

function formatCell(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export default function SearchTable({
  refreshSignal = 0,
  endpoint = "/api/search",
  pageSize = 20,
}: SearchTableProps) {
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<SearchRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Stack of cursors for the pages we've visited, enabling a "Previous" button.
  // cursorStack[i] is the cursor that produced the currently visible page.
  const [cursorStack, setCursorStack] = useState<(string | null)[]>([null]);

  const abortRef = useRef<AbortController | null>(null);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchPage = useCallback(
    async (q: string, cursor: string | null) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({ q, limit: String(pageSize) });
        if (cursor) params.set("cursor", cursor);
        const res = await fetch(`${endpoint}?${params}`, {
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json: SearchResponse = await res.json();
        setRows(Array.isArray(json.rows) ? json.rows : []);
        setNextCursor(json.nextCursor ?? null);
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        setError((err as Error).message);
        setRows([]);
        setNextCursor(null);
      } finally {
        setLoading(false);
      }
    },
    [endpoint, pageSize],
  );

  // Debounced search: any query change resets pagination to the first page.
  useEffect(() => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      setCursorStack([null]);
      fetchPage(query, null);
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, [query, fetchPage]);

  // SSE-driven refresh: refetch whichever page is currently shown.
  useEffect(() => {
    if (refreshSignal === 0) return;
    fetchPage(query, cursorStack[cursorStack.length - 1]);
    // Only react to the signal; query/cursor are read as current values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshSignal]);

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  const goNext = useCallback(() => {
    if (!nextCursor) return;
    setCursorStack((s) => [...s, nextCursor]);
    fetchPage(query, nextCursor);
  }, [nextCursor, query, fetchPage]);

  const goPrev = useCallback(() => {
    if (cursorStack.length <= 1) return;
    const stack = cursorStack.slice(0, -1);
    setCursorStack(stack);
    fetchPage(query, stack[stack.length - 1]);
  }, [cursorStack, query, fetchPage]);

  const columns = useMemo(() => {
    const cols: string[] = [];
    for (const row of rows) {
      for (const key of Object.keys(row)) {
        if (!cols.includes(key)) cols.push(key);
      }
    }
    return cols;
  }, [rows]);

  const page = cursorStack.length;
  const hasPrev = cursorStack.length > 1;

  return (
    <section className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-800 dark:bg-gray-900">
      <header className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold">Search</h2>
        {loading && (
          <span className="text-xs text-indigo-500" aria-live="polite">
            searching…
          </span>
        )}
      </header>

      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search records…"
        className="mb-3 w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 dark:border-gray-700 dark:bg-gray-950"
        aria-label="Search records"
      />

      <div className="overflow-x-auto">
        {error ? (
          <div className="py-10 text-center text-sm text-red-500">
            Search failed: {error}
          </div>
        ) : rows.length === 0 ? (
          <div className="py-10 text-center text-sm text-gray-400">
            {loading ? "Loading…" : "No results."}
          </div>
        ) : (
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-left dark:border-gray-800">
                {columns.map((col) => (
                  <th
                    key={col}
                    className="px-3 py-2 font-medium text-gray-500"
                  >
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr
                  key={(row.id as string | number | undefined) ?? i}
                  className="border-b border-gray-100 hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-800/50"
                >
                  {columns.map((col) => (
                    <td key={col} className="px-3 py-2 align-top">
                      {formatCell(row[col])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <footer className="mt-3 flex items-center justify-between">
        <span className="text-xs text-gray-400">Page {page}</span>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={goPrev}
            disabled={!hasPrev || loading}
            className="rounded-md border border-gray-300 px-3 py-1 text-sm disabled:cursor-not-allowed disabled:opacity-40 dark:border-gray-700"
          >
            Previous
          </button>
          <button
            type="button"
            onClick={goNext}
            disabled={!nextCursor || loading}
            className="rounded-md border border-gray-300 px-3 py-1 text-sm disabled:cursor-not-allowed disabled:opacity-40 dark:border-gray-700"
          >
            Next
          </button>
        </div>
      </footer>
    </section>
  );
}

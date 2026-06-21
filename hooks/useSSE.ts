"use client";

import { useEffect, useRef, useState } from "react";

export type SSEStatus = "connecting" | "open" | "closed" | "error";

export interface UseSSEOptions<T> {
  /** Called for every message; receives the parsed payload (JSON when possible). */
  onMessage?: (data: T, event: MessageEvent) => void;
  /** Pause/resume the connection without unmounting. Defaults to true. */
  enabled?: boolean;
  /** Listen to named events in addition to the default `message` event. */
  events?: string[];
  /** Reconnect backoff bounds in milliseconds. */
  baseReconnectMs?: number;
  maxReconnectMs?: number;
}

export interface UseSSEResult<T> {
  status: SSEStatus;
  /** Most recently received (parsed) payload. */
  lastEvent: T | null;
  /** Number of successful (re)connections — useful as a render key. */
  connectionCount: number;
  /** Manually close; auto-reconnect stops until `enabled` toggles or remount. */
  close: () => void;
}

function parse<T>(raw: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return raw as unknown as T;
  }
}

/**
 * Subscribe to a Server-Sent Events endpoint with automatic reconnection.
 *
 * Reconnection uses exponential backoff (with jitter) and resets once a
 * connection successfully opens, so transient drops recover quickly while a
 * persistently down server is not hammered.
 */
export function useSSE<T = unknown>(
  url: string,
  options: UseSSEOptions<T> = {},
): UseSSEResult<T> {
  const {
    onMessage,
    enabled = true,
    events,
    baseReconnectMs = 1000,
    maxReconnectMs = 30000,
  } = options;

  const [status, setStatus] = useState<SSEStatus>("closed");
  const [lastEvent, setLastEvent] = useState<T | null>(null);
  const [connectionCount, setConnectionCount] = useState(0);

  // Keep the latest callback without re-subscribing every render.
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  const sourceRef = useRef<EventSource | null>(null);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptRef = useRef(0);
  const closedByUser = useRef(false);

  // Stable identity for the named-events array across renders.
  const eventsKey = events ? events.join(",") : "";

  useEffect(() => {
    if (!enabled) {
      setStatus("closed");
      return;
    }
    closedByUser.current = false;

    const clearRetry = () => {
      if (retryTimer.current) {
        clearTimeout(retryTimer.current);
        retryTimer.current = null;
      }
    };

    const connect = () => {
      clearRetry();
      setStatus("connecting");

      const es = new EventSource(url);
      sourceRef.current = es;

      const handle = (event: MessageEvent) => {
        const data = parse<T>(event.data);
        setLastEvent(data);
        onMessageRef.current?.(data, event);
      };

      es.onopen = () => {
        attemptRef.current = 0; // reset backoff on a healthy connection
        setStatus("open");
        setConnectionCount((c) => c + 1);
      };

      es.onmessage = handle;
      const named = eventsKey ? eventsKey.split(",") : [];
      for (const name of named) es.addEventListener(name, handle as EventListener);

      es.onerror = () => {
        // EventSource auto-reconnects on its own, but to apply our backoff
        // policy we close and schedule a controlled retry.
        es.close();
        sourceRef.current = null;
        if (closedByUser.current) return;

        setStatus("error");
        const delay = Math.min(
          baseReconnectMs * 2 ** attemptRef.current,
          maxReconnectMs,
        );
        attemptRef.current += 1;
        const jitter = Math.random() * 0.3 * delay;
        retryTimer.current = setTimeout(connect, delay + jitter);
      };
    };

    connect();

    return () => {
      closedByUser.current = true;
      clearRetry();
      sourceRef.current?.close();
      sourceRef.current = null;
    };
  }, [url, enabled, eventsKey, baseReconnectMs, maxReconnectMs]);

  const close = () => {
    closedByUser.current = true;
    if (retryTimer.current) clearTimeout(retryTimer.current);
    sourceRef.current?.close();
    sourceRef.current = null;
    setStatus("closed");
  };

  return { status, lastEvent, connectionCount, close };
}

export default useSSE;

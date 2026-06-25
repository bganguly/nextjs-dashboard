import { Client } from "pg";
import { AppError } from "@/lib/errors";
import { resolvePgUrl } from "@/lib/pg-url";
import type { OrderNotification } from "@/lib/types";
import { prisma } from "@/lib/prisma";

/**
 * Real-time order stream backed by Postgres LISTEN/NOTIFY. The raw `pg` driver
 * is an implementation detail that lives only inside this service; routes and
 * scripts interact through the typed functions below.
 */
const CHANNEL = "orders_channel";

export interface OrderStreamHandlers {
  onConnect?: () => void;
  onOrder: (notification: OrderNotification) => void;
  onError?: (error: AppError) => void;
}

export interface StreamSubscription {
  close: () => Promise<void>;
}

export async function subscribeToOrders(
  handlers: OrderStreamHandlers,
): Promise<StreamSubscription> {
  let connectionString: string;
  try {
    const rawUrl = resolvePgUrl();
    // Strip sslmode from the URL so it doesn't conflict with the ssl constructor option.
    // pg v8 parses sslmode and can override the ssl object we pass in.
    const parsed = new URL(rawUrl);
    parsed.searchParams.delete("sslmode");
    connectionString = parsed.toString();
  } catch (err) {
    throw new AppError("INTERNAL", err instanceof Error ? err.message : "invalid Postgres URL");
  }

  const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });

  const close = async () => {
    try {
      await client.query("UNLISTEN *");
      await client.end();
    } catch {
      // best-effort cleanup
    }
  };

  try {
    await client.connect();
    await client.query(`LISTEN ${CHANNEL}`);
  } catch (err) {
    await close();
    throw new AppError("DB_ERROR", "failed to subscribe to the order stream", {
      cause: err instanceof Error ? err.message : String(err),
    });
  }

  client.on("notification", (msg) => {
    try {
      const payload = msg.payload ? (JSON.parse(msg.payload) as OrderNotification) : null;
      if (payload) handlers.onOrder(payload);
    } catch {
      handlers.onError?.(new AppError("INTERNAL", "failed to parse order notification"));
    }
  });

  client.on("error", (err) => {
    handlers.onError?.(
      new AppError("DB_ERROR", "order stream connection error", { cause: err.message }),
    );
  });

  handlers.onConnect?.();
  return { close };
}

/**
 * Publish an order event to every connected SSE subscriber. Uses the Prisma
 * connection pool so no new TCP connection is opened per call.
 */
export async function publishOrderEvent(notification: OrderNotification): Promise<void> {
  await prisma.$executeRaw`SELECT pg_notify('orders_channel', ${JSON.stringify(notification)})`;
}

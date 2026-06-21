import { NextRequest } from "next/server";
import { Client } from "pg";

// GET /api/stream — SSE endpoint using Postgres LISTEN/NOTIFY
// The channel "orders_channel" receives NOTIFY from a DB trigger or demo-writer.ts
export async function GET(req: NextRequest) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const client = new Client({ connectionString: process.env.DATABASE_URL });

      const send = (event: string, data: unknown) => {
        const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        controller.enqueue(encoder.encode(payload));
      };

      const cleanup = async () => {
        try {
          await client.query("UNLISTEN *");
          await client.end();
        } catch {
          // ignore cleanup errors
        }
      };

      try {
        await client.connect();
        await client.query("LISTEN orders_channel");

        send("connected", { ts: new Date().toISOString() });

        client.on("notification", (msg) => {
          try {
            const payload = msg.payload ? JSON.parse(msg.payload) : {};
            send("order", payload);
          } catch {
            send("order", { raw: msg.payload });
          }
        });

        client.on("error", async (err) => {
          send("error", { message: err.message });
          await cleanup();
          controller.close();
        });

        // Heartbeat every 25s to keep the connection alive
        const heartbeat = setInterval(() => {
          send("heartbeat", { ts: new Date().toISOString() });
        }, 25_000);

        req.signal.addEventListener("abort", async () => {
          clearInterval(heartbeat);
          await cleanup();
          controller.close();
        });
      } catch (err) {
        send("error", { message: err instanceof Error ? err.message : "connection failed" });
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

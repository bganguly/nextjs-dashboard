import { NextResponse } from "next/server";
import { getSeedStats, isAppError } from "@/lib/services";

// GET /api/seed-stats — returns actual customer + product counts for Quick Order bounds
export async function GET() {
  try {
    const stats = await getSeedStats();
    return NextResponse.json(stats);
  } catch (err) {
    if (isAppError(err)) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    }
    return NextResponse.json({ error: "internal server error" }, { status: 500 });
  }
}

import { NextResponse } from "next/server";
import { backfillState } from "@/lib/backfill-state";

export async function GET() {
  return NextResponse.json(backfillState);
}

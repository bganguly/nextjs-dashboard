import { query } from "@/lib/db";
import { mapDbError } from "@/lib/errors";
import type { RegionOption } from "@/lib/types";

export async function listRegions(): Promise<RegionOption[]> {
  try {
    const rows = await query<{ region_id: number; code: string; name: string }>(
      `SELECT region_id, code, name FROM regions ORDER BY name ASC`,
    );
    return rows.map((r) => ({ id: r.region_id, code: r.code, name: r.name }));
  } catch (err) {
    mapDbError(err, "listRegions");
  }
}

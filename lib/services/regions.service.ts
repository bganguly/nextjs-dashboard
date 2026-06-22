import { prisma } from "@/lib/prisma";
import { mapDbError } from "@/lib/errors";
import type { RegionOption } from "@/lib/types";

/** The full region list for filter dropdowns — ordered by name. */
export async function listRegions(): Promise<RegionOption[]> {
  try {
    return await prisma.region.findMany({
      select: { code: true, name: true },
      orderBy: { name: "asc" },
    });
  } catch (err) {
    mapDbError(err, "listRegions");
  }
}

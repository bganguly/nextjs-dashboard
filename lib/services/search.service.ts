import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { AppError, mapDbError } from "@/lib/errors";
import type { SearchInput, SearchResult, SearchResultItem } from "@/lib/types";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

export async function search(input: SearchInput): Promise<SearchResult> {
  const q = input.q?.trim();
  if (!q) throw new AppError("BAD_REQUEST", "q (search query) is required");

  const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

  const where: Prisma.SearchIndexWhereInput = {
    content: { contains: q, mode: "insensitive" },
    ...(input.entityType ? { entityType: input.entityType } : {}),
  };

  try {
    const rows = await prisma.searchIndex.findMany({
      where,
      take: limit,
      orderBy: { updatedAt: "desc" },
    });

    const results: SearchResultItem[] = rows.map((r) => ({
      entityType: r.entityType,
      entityId: r.entityId,
      content: r.content,
    }));

    return { query: q, results };
  } catch (err) {
    mapDbError(err, "search");
  }
}

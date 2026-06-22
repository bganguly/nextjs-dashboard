import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { AppError, mapDbError } from "@/lib/errors";
import type {
  CreateCustomerInput,
  CustomerDTO,
  CustomerListInput,
  CustomerListResult,
} from "@/lib/types";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const customerInclude = {
  region: { select: { id: true, code: true, name: true } },
} satisfies Prisma.CustomerInclude;

type CustomerWithRegion = Prisma.CustomerGetPayload<{ include: typeof customerInclude }>;

function toCustomerDTO(c: CustomerWithRegion): CustomerDTO {
  return {
    id: c.id,
    email: c.email,
    firstName: c.firstName,
    lastName: c.lastName,
    phone: c.phone,
    region: c.region,
    createdAt: c.createdAt.toISOString(),
  };
}

export async function listCustomers(input: CustomerListInput): Promise<CustomerListResult> {
  const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const q = input.q?.trim();

  const where: Prisma.CustomerWhereInput = {
    ...(input.regionId ? { regionId: input.regionId } : {}),
    ...(q
      ? {
          OR: [
            { email: { contains: q, mode: "insensitive" } },
            { firstName: { contains: q, mode: "insensitive" } },
            { lastName: { contains: q, mode: "insensitive" } },
          ],
        }
      : {}),
  };

  try {
    const rows = await prisma.customer.findMany({
      where,
      take: limit + 1,
      ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
      orderBy: { id: "asc" },
      include: customerInclude,
    });

    const hasMore = rows.length > limit;
    const data = (hasMore ? rows.slice(0, limit) : rows).map(toCustomerDTO);
    const nextCursor = hasMore ? data[data.length - 1].id : null;

    return { data, nextCursor, hasMore };
  } catch (err) {
    mapDbError(err, "listCustomers");
  }
}

export async function getCustomer(id: number): Promise<CustomerDTO> {
  try {
    const c = await prisma.customer.findUnique({ where: { id }, include: customerInclude });
    if (!c) throw new AppError("NOT_FOUND", `customer ${id} not found`);
    return toCustomerDTO(c);
  } catch (err) {
    mapDbError(err, "getCustomer");
  }
}

export async function createCustomer(input: CreateCustomerInput): Promise<CustomerDTO> {
  if (!input.email || !input.firstName || !input.lastName || !input.regionId) {
    throw new AppError("BAD_REQUEST", "email, firstName, lastName, and regionId are required");
  }
  try {
    const c = await prisma.customer.create({
      data: {
        email: input.email,
        firstName: input.firstName,
        lastName: input.lastName,
        phone: input.phone ?? null,
        regionId: input.regionId,
      },
      include: customerInclude,
    });
    return toCustomerDTO(c);
  } catch (err) {
    mapDbError(err, "createCustomer");
  }
}

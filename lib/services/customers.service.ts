import { query, execute } from "@/lib/db";
import { AppError, mapDbError } from "@/lib/errors";
import type {
  CreateCustomerInput, CustomerDTO, CustomerListInput, CustomerListResult,
} from "@/lib/types";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function toDTO(r: {
  customer_id: string; email: string; first_name: string; last_name: string;
  phone: string | null; region_id: number; region_code: string; region_name: string;
  created_at: Date;
}): CustomerDTO {
  return {
    id: Number(r.customer_id),
    email: r.email,
    firstName: r.first_name,
    lastName: r.last_name,
    phone: r.phone,
    region: { id: r.region_id, code: r.region_code, name: r.region_name },
    createdAt: new Date(r.created_at).toISOString(),
  };
}

export async function listCustomers(input: CustomerListInput): Promise<CustomerListResult> {
  const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const q = input.q?.trim();

  const clauses: string[] = [];
  const params: unknown[] = [];
  let pi = 1;

  if (q) {
    clauses.push(`(c.first_name || ' ' || c.last_name || ' ' || c.email) ILIKE '%' || $${pi++} || '%'`);
    params.push(q);
  }
  if (input.regionId) {
    clauses.push(`c.region_id = $${pi++}`);
    params.push(input.regionId);
  }
  if (input.cursor) {
    clauses.push(`c.customer_id > $${pi++}`);
    params.push(input.cursor);
  }

  const limN = pi;
  params.push(limit + 1);
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

  try {
    const rows = await query<{
      customer_id: string; email: string; first_name: string; last_name: string;
      phone: string | null; region_id: number; region_code: string; region_name: string;
      created_at: Date;
    }>(
      `SELECT c.customer_id, c.email, c.first_name, c.last_name, c.phone, c.region_id,
              r.code AS region_code, r.name AS region_name, c.created_at
       FROM customers c JOIN regions r ON r.region_id = c.region_id
       ${where}
       ORDER BY c.customer_id ASC
       LIMIT $${limN}`,
      params,
    );

    const hasMore = rows.length > limit;
    const data = (hasMore ? rows.slice(0, limit) : rows).map(toDTO);
    const nextCursor = hasMore ? data[data.length - 1].id : null;
    return { data, nextCursor, hasMore };
  } catch (err) {
    mapDbError(err, "listCustomers");
  }
}

export async function getCustomer(id: number): Promise<CustomerDTO> {
  try {
    const rows = await query<{
      customer_id: string; email: string; first_name: string; last_name: string;
      phone: string | null; region_id: number; region_code: string; region_name: string;
      created_at: Date;
    }>(
      `SELECT c.customer_id, c.email, c.first_name, c.last_name, c.phone, c.region_id,
              r.code AS region_code, r.name AS region_name, c.created_at
       FROM customers c JOIN regions r ON r.region_id = c.region_id
       WHERE c.customer_id = $1 LIMIT 1`,
      [id],
    );
    if (rows.length === 0) throw new AppError("NOT_FOUND", `customer ${id} not found`);
    return toDTO(rows[0]);
  } catch (err) {
    mapDbError(err, "getCustomer");
  }
}

let _customerId = Date.now();

export async function createCustomer(input: CreateCustomerInput): Promise<CustomerDTO> {
  if (!input.email || !input.firstName || !input.lastName || !input.regionId) {
    throw new AppError("BAD_REQUEST", "email, firstName, lastName, and regionId are required");
  }
  try {
    const regionRows = await query<{ region_id: number; code: string; name: string }>(
      `SELECT region_id, code, name FROM regions WHERE region_id = $1 LIMIT 1`,
      [input.regionId],
    );
    if (regionRows.length === 0) throw new AppError("NOT_FOUND", `region ${input.regionId} not found`);

    const customerId = ++_customerId;
    await execute(
      `INSERT INTO customers (customer_id, email, first_name, last_name, phone, region_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      [customerId, input.email, input.firstName, input.lastName, input.phone ?? null, input.regionId],
    );

    return {
      id: customerId,
      email: input.email,
      firstName: input.firstName,
      lastName: input.lastName,
      phone: input.phone ?? null,
      region: { id: input.regionId, code: regionRows[0].code, name: regionRows[0].name },
      createdAt: new Date().toISOString(),
    };
  } catch (err) {
    mapDbError(err, "createCustomer");
  }
}

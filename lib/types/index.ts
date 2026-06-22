/**
 * Shared, framework- and Prisma-agnostic types used across the service layer
 * and the route handlers. Nothing here may import from "@prisma/client".
 */

export type OrderStatus =
  | "PENDING"
  | "CONFIRMED"
  | "PROCESSING"
  | "SHIPPED"
  | "DELIVERED"
  | "CANCELLED"
  | "REFUNDED";

// ---------- Shared summaries ----------

export interface CustomerSummary {
  id: number;
  email: string;
  firstName: string;
  lastName: string;
}

export interface RegionSummary {
  id: number;
  code: string;
  name: string;
}

export interface ProductSummary {
  id: number;
  sku: string;
  name: string;
}

// ---------- Orders ----------

export interface OrderItemDTO {
  id: number;
  productId: number;
  quantity: number;
  unitPrice: number;
  discount: number;
  product?: ProductSummary;
}

export interface OrderDTO {
  id: number;
  status: OrderStatus;
  total: number;
  currency: string;
  notes: string | null;
  placedAt: string;
  customer: CustomerSummary;
  region: RegionSummary;
  items: OrderItemDTO[];
}

export interface OrderListInput {
  cursor?: number | null;
  limit?: number;
  q?: string | null;
}

export interface OrderListResult {
  data: OrderDTO[];
  nextCursor: number | null;
  hasMore: boolean;
}

export interface CreateOrderItemInput {
  productId: number;
  quantity: number;
  unitPrice: number;
  discount?: number;
}

export interface CreateOrderInput {
  customerId: number;
  regionId: number;
  currency?: string;
  notes?: string | null;
  items: CreateOrderItemInput[];
}

// ---------- Aggregates ----------

export interface AggregateQueryInput {
  from: string;
  to: string;
  regionCode?: string | null;
}

export interface CategoryAggregate {
  totalOrders: number;
  totalRevenue: number;
  totalItems: number;
  avgOrderValue: number;
}

export interface DailyAggregate {
  date: string;
  categories: Record<string, CategoryAggregate>;
  totals: { totalOrders: number; totalRevenue: number; totalItems: number };
}

// ---------- Customers ----------

export interface CustomerDTO {
  id: number;
  email: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  region: RegionSummary;
  createdAt: string;
}

export interface CustomerListInput {
  cursor?: number | null;
  limit?: number;
  q?: string | null;
  regionId?: number | null;
}

export interface CustomerListResult {
  data: CustomerDTO[];
  nextCursor: number | null;
  hasMore: boolean;
}

export interface CreateCustomerInput {
  email: string;
  firstName: string;
  lastName: string;
  phone?: string | null;
  regionId: number;
}

// ---------- Products ----------

export interface ProductDTO {
  id: number;
  sku: string;
  name: string;
  description: string | null;
  price: number;
  cost: number;
  stock: number;
  categoryId: number;
  categoryName?: string;
}

export interface ProductListInput {
  cursor?: number | null;
  limit?: number;
  q?: string | null;
  categoryId?: number | null;
}

export interface ProductListResult {
  data: ProductDTO[];
  nextCursor: number | null;
  hasMore: boolean;
}

export interface CreateProductInput {
  sku: string;
  name: string;
  description?: string | null;
  price: number;
  cost: number;
  stock?: number;
  categoryId: number;
}

// ---------- Search ----------

export type SearchEntityType = "order" | "product" | "customer" | (string & {});

export interface SearchInput {
  q: string;
  entityType?: SearchEntityType | null;
  limit?: number;
}

export interface SearchResultItem {
  entityType: string;
  entityId: number;
  content: string;
}

export interface SearchResult {
  query: string;
  results: SearchResultItem[];
}

// ---------- Stream ----------

export interface OrderNotification {
  id: number;
  total: number;
  customerId: number;
  customerEmail?: string;
  regionCode?: string;
  placedAt: string;
}

export type StreamEventName = "connected" | "order" | "heartbeat" | "error";

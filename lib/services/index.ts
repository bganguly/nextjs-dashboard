/**
 * Public surface of the service layer. Route handlers import from here only —
 * never from "@prisma/client" or "@/lib/prisma" directly.
 */
export * from "./orders.service";
export * from "./aggregates.service";
export * from "./customers.service";
export * from "./products.service";
export * from "./regions.service";
export * from "./search.service";
export * from "./stream.service";

// Typed error helpers are re-exported so routes can map failures to HTTP
// responses without reaching outside the service layer.
export { AppError, isAppError } from "@/lib/errors";
export type { AppErrorCode } from "@/lib/errors";

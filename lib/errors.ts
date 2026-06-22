import { Prisma } from "@prisma/client";

/**
 * Typed application errors. Services translate all low-level/DB failures into
 * an AppError so that nothing Prisma-specific ever leaks past the service layer.
 */
export type AppErrorCode =
  | "BAD_REQUEST"
  | "VALIDATION"
  | "NOT_FOUND"
  | "CONFLICT"
  | "DB_ERROR"
  | "INTERNAL";

const STATUS_BY_CODE: Record<AppErrorCode, number> = {
  BAD_REQUEST: 400,
  VALIDATION: 422,
  NOT_FOUND: 404,
  CONFLICT: 409,
  DB_ERROR: 500,
  INTERNAL: 500,
};

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: AppErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.details = details;
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}

/**
 * Normalise any thrown value (Prisma errors included) into a typed AppError.
 * Always throws — never returns — so it can be used as the catch-block tail
 * of a service function without confusing control-flow analysis.
 */
export function mapDbError(err: unknown, context: string): never {
  if (err instanceof AppError) throw err;

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    switch (err.code) {
      case "P2002":
        throw new AppError("CONFLICT", `${context}: unique constraint violation`, {
          fields: err.meta?.target,
        });
      case "P2025":
        throw new AppError("NOT_FOUND", `${context}: record not found`);
      case "P2003":
        throw new AppError("BAD_REQUEST", `${context}: foreign key constraint failed`, {
          field: err.meta?.field_name,
        });
      default:
        throw new AppError("DB_ERROR", `${context}: database error (${err.code})`);
    }
  }

  if (err instanceof Prisma.PrismaClientValidationError) {
    throw new AppError("VALIDATION", `${context}: invalid query`);
  }

  throw new AppError("INTERNAL", `${context}: unexpected error`, {
    cause: err instanceof Error ? err.message : String(err),
  });
}

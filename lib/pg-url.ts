/**
 * Resolve a connection string for the raw `pg` driver (used for LISTEN/NOTIFY).
 *
 * `DATABASE_URL` may be a Prisma-specific `prisma+postgres://` proxy URL (e.g.
 * produced by `prisma dev` / Prisma Postgres). The `pg` driver cannot parse that
 * scheme, so the raw-pg code paths require a standard `postgresql://` URL.
 *
 * Resolution order:
 *   1. DIRECT_DATABASE_URL  (preferred — an explicit direct connection)
 *   2. PG_URL               (alias)
 *   3. DATABASE_URL         (only if it is already a standard postgres URL)
 *
 * This module intentionally has no other imports so it can be loaded from both
 * Next.js (via the "@/" alias) and standalone scripts (via a relative path).
 */
export function resolvePgUrl(): string {
  const candidate =
    process.env.DIRECT_DATABASE_URL ?? process.env.PG_URL ?? process.env.DATABASE_URL ?? "";

  if (!candidate) {
    throw new Error(
      "No Postgres connection string found. Set DIRECT_DATABASE_URL to a standard " +
        "postgresql:// URL for the LISTEN/NOTIFY (pg) code paths.",
    );
  }

  if (!isStandardPostgresUrl(candidate)) {
    const scheme = candidate.split("://")[0];
    throw new Error(
      `The raw pg client requires a standard postgresql:// URL, but the configured URL uses ` +
        `"${scheme}://". Set DIRECT_DATABASE_URL (or PG_URL) to a standard postgresql:// ` +
        "connection string. (DATABASE_URL may stay a prisma+postgres:// URL for Prisma.)",
    );
  }

  return candidate;
}

export function isStandardPostgresUrl(url: string): boolean {
  return /^postgres(ql)?:\/\//i.test(url);
}

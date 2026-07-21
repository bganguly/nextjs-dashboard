export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { runMigrations } = await import("./lib/schema");
    await runMigrations().catch((err) =>
      console.error("[migrations] failed:", err),
    );
  }
}
